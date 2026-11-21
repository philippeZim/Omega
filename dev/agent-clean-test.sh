#!/usr/bin/env bash
# Scenarios for `dev/agent.sh clean`, run in a throwaway repository (never the real one).
#   dev/agent-clean-test.sh [path/to/agent.sh]
set -euo pipefail
agent=$(realpath "${1:-$(dirname "$0")/agent.sh}")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null STOP_LOG="$tmp/stops"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
repo="$tmp/repo" wts="$tmp/ide-wt" fails=0
g() { git -C "$repo" "$@"; }
# The counter keeps commits distinct: equal empty commits made in the same second share one hash.
n=0
c() { n=$((n + 1)); git -C "$1" commit -q --allow-empty -m "$2 $n"; }
wt() { g worktree add -q -b "$1" "$wts/${1//\//-}" "${2:-dev}"; }
path() { echo "$wts/${1//\//-}"; }
merge() { g merge -q --no-ff -m "Merge $1: done" "$1"; }

git init -q -b dev "$repo"
mkdir "$repo/dev"
# Stands in for the instance manager: records which worktree was asked to stop its instances.
echo 'import fs from "node:fs"; fs.appendFileSync(process.env.STOP_LOG, process.cwd() + "\n");' > "$repo/dev/omega-mcp.mjs"
g add -A; g commit -q -m base

wt fix/1-fresh
wt fix/2-merged;        c "$(path fix/2-merged)" work
wt fix/3-rebased;       c "$(path fix/3-rebased)" work
wt fix/4-merged-ff;     c "$(path fix/4-merged-ff)" work
wt fix/5-fresh-ff
wt fix/7-unmerged;      c "$(path fix/7-unmerged)" work
wt fix/8-more-work;     c "$(path fix/8-more-work)" work
wt fix/9-dirty;         c "$(path fix/9-dirty)" work
wt fix/10-locked;       c "$(path fix/10-locked)" work
wt fix/11-dry;          c "$(path fix/11-dry)" work

c "$repo" "dev moves"
git -C "$(path fix/3-rebased)" rebase -q dev
merge fix/2-merged; merge fix/3-rebased; merge fix/4-merged-ff
merge fix/8-more-work; merge fix/9-dirty; merge fix/10-locked
c "$(path fix/8-more-work)" "follow-up"
echo x > "$(path fix/9-dirty)/dirty"
g worktree lock "$(path fix/10-locked)"
git -C "$(path fix/4-merged-ff)" merge -q --ff-only dev
git -C "$(path fix/5-fresh-ff)" merge -q --ff-only dev

# A fresh branch at a commit that is a merge parent only because dev was merged into a feature.
c "$repo" "plain commit on dev"
y=$(g rev-parse dev)
wt fix/6-fresh-at-parent "$y"
g checkout -q -b feat/side "$y~1"; c "$repo" side
g merge -q --no-ff -m "Merge branch 'dev' into feat/side" "$y"
g checkout -q dev; g merge -q --ff-only feat/side; g branch -q -d feat/side
c "$repo" "dev moves again"

check() { # <branch> <gone|kept> <stopped|running>
  local d; d=$(path "$1")
  local have=kept; [[ -e $d ]] || have=gone
  local inst=running; grep -qxF "$(realpath -m "$d")" "$STOP_LOG" 2>/dev/null && inst=stopped
  local br=gone; g show-ref -q --verify "refs/heads/$1" && br=kept
  if [[ $have == "$2" && $br == "$2" && $inst == "$3" ]]; then echo "ok    $1: $have, $inst"
  else echo "FAIL  $1: worktree $have, branch $br, $inst (expected $2, $3)"; fails=$((fails + 1)); fi
}

# Dry run first: nothing may change.
merge fix/11-dry
(cd "$repo" && bash "$agent" clean --dry-run >/dev/null)
[[ ! -e $STOP_LOG && -e $(path fix/2-merged) ]] && echo "ok    dry run changes nothing" || { echo "FAIL  dry run changed something"; fails=$((fails + 1)); }

(cd "$repo" && bash "$agent" clean >/dev/null)
check fix/1-fresh          kept running
check fix/2-merged         gone stopped
check fix/3-rebased        gone stopped
check fix/4-merged-ff      gone stopped
check fix/5-fresh-ff       kept running
check fix/6-fresh-at-parent kept running
check fix/7-unmerged       kept running
check fix/8-more-work      kept running
check fix/9-dirty          kept running
check fix/10-locked        kept running
check fix/11-dry           gone stopped

[[ $fails == 0 ]] && echo "Alle Szenarien bestanden" || { echo "$fails Szenarien fehlgeschlagen"; exit 1; }
