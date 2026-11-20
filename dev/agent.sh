#!/usr/bin/env bash
# Worktrees for parallel AI agents: one issue = one branch from `dev` = one worktree.
#
#   dev/agent.sh new <issue-nr> [slug]   worktree + branch fix/<nr>-<slug> or feat/<nr>-<slug> from dev
#   dev/agent.sh new <name>              worktree + branch feat/<name> (no issue)
#   dev/agent.sh list                    worktrees: branch, commits ahead/behind dev, changes, instances
#   dev/agent.sh clean [--dry-run]       removes worktrees whose branch is merged into dev
#
# Worktrees live next to the repo in ../ide-wt/<branch>. The Rust build cache of the main
# checkout is copied with reflinks (btrfs/XFS: ~3 s, no extra space), so the first build only
# compiles Omega itself.
set -euo pipefail

main_root=$(git worktree list --porcelain | awk 'NR==1 { print $2 }')
wt_base="$(dirname "$main_root")/ide-wt"
base=dev

die() { echo "agent.sh: $*" >&2; exit 1; }

slugify() { tr '[:upper:]' '[:lower:]' | sed -E 's/\[[^]]*\]//g; s/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40 | sed -E 's/-+$//'; }

cmd_new() {
  local arg=${1:-} slug=${2:-} branch kind=feat title=""
  [[ -n $arg ]] || die "Benutzung: agent.sh new <issue-nr|name> [slug]"
  git -C "$main_root" rev-parse --verify -q "$base" >/dev/null || die "Branch '$base' fehlt"
  if [[ $arg =~ ^[0-9]+$ ]]; then
    if command -v gh >/dev/null && json=$(gh issue view "$arg" --json title,labels 2>/dev/null); then
      title=$(jq -r .title <<<"$json")
      if jq -e '.labels[].name | select(. == "bug")' <<<"$json" >/dev/null || [[ $title == "[Bug]"* ]]; then kind=fix; fi
    fi
    [[ -n $slug ]] || slug=$(slugify <<<"${title:-issue}")
    branch="$kind/$arg-$slug"
  else
    branch="feat/$(slugify <<<"$arg")"
  fi
  local dir="$wt_base/${branch//\//-}"
  [[ -e $dir ]] && die "$dir existiert schon"
  mkdir -p "$wt_base"
  git -C "$main_root" worktree add -b "$branch" "$dir" "$base"

  # Rust build cache (reflink copy, falls back to a fresh build).
  if [[ -d $main_root/src-tauri/target/debug ]]; then
    mkdir -p "$dir/src-tauri/target"
    if cp -a --reflink=always "$main_root/src-tauri/target/debug" "$dir/src-tauri/target/" 2>/dev/null; then
      echo "Build-Cache übernommen (Reflink)"
    else
      rm -rf "$dir/src-tauri/target/debug"
      echo "Kein Reflink möglich – erster Build kompiliert alles"
    fi
  fi
  (cd "$dir" && pnpm install --frozen-lockfile --prefer-offline >/dev/null) && echo "pnpm install ok"

  echo
  echo "Worktree: $dir"
  echo "Branch:   $branch (von $base)${title:+  –  $title}"
  echo "Agent dort starten, z. B.:  cd $dir && claude"
}

cmd_list() {
  local instances
  instances=$(node "$main_root/dev/omega-mcp.mjs" list 2>/dev/null || echo "[]")
  printf '%-48s %-34s %9s %-9s %s\n' WORKTREE BRANCH "+/-$base" ÄNDERUNG INSTANZEN
  git -C "$main_root" worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{sub("refs/heads/","",$2); print w, $2}' |
    while read -r dir branch; do
      local ab dirty inst
      ab=$(git -C "$main_root" rev-list --left-right --count "$base...$branch" 2>/dev/null | awk '{print "+"$2"/-"$1}')
      dirty=$([[ -n $(git -C "$dir" status --porcelain 2>/dev/null) ]] && echo ja || echo -)
      inst=$(jq -r --arg d "$dir" '[.[] | select(.worktree == $d) | .name] | join(",")' <<<"$instances")
      printf '%-48s %-34s %9s %-9s %s\n' "${dir/#$HOME/\~}" "$branch" "${ab:-?}" "$dirty" "${inst:--}"
    done
}

cmd_clean() {
  local dry=${1:-}
  git -C "$main_root" worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{sub("refs/heads/","",$2); print w, $2}' |
    while read -r dir branch; do
      [[ $dir == "$main_root" || $branch == "$base" || $branch == main ]] && continue
      # Merged = no commits that dev lacks (also true for a fresh, empty branch → keep those).
      [[ $(git -C "$main_root" rev-list --count "$base..$branch") == 0 ]] || continue
      [[ $(git -C "$main_root" rev-list --count "$(git -C "$main_root" merge-base "$base" "$branch")..$base") -gt 0 ]] || continue
      if [[ -n $(git -C "$dir" status --porcelain 2>/dev/null) ]]; then echo "übersprungen (ungespeicherte Änderungen): $dir"; continue; fi
      if [[ $dry == --dry-run ]]; then echo "würde entfernen: $dir ($branch)"; continue; fi
      (cd "$dir" && node dev/omega-mcp.mjs stop all >/dev/null 2>&1 || true)
      git -C "$main_root" worktree remove "$dir" && git -C "$main_root" branch -d "$branch" >/dev/null && echo "entfernt: $dir ($branch)"
    done
}

case ${1:-} in
  new) shift; cmd_new "$@" ;;
  list) cmd_list ;;
  clean) shift; cmd_clean "${1:-}" ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
