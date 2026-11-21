#!/usr/bin/env bash
# Publishes screenshots for GitHub issues on the orphan branch `test-artifacts` and prints one
# raw URL per file. Usage: dev/qa/publish-shots.sh <subdir> <png>...
# Uses its own worktree (../.omega-test-artifacts), so the current checkout is never touched.
set -euo pipefail
sub="${1:?subdir, e.g. 2026-11-20-explorer}"; shift
repo="$(git rev-parse --show-toplevel)"
wt="$(dirname "$repo")/.omega-test-artifacts"
slug="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
if [ ! -d "$wt" ]; then
  if git -C "$repo" ls-remote --exit-code --heads origin test-artifacts >/dev/null; then
    git -C "$repo" fetch -q origin test-artifacts
    git -C "$repo" worktree add -q "$wt" test-artifacts
  else
    git -C "$repo" worktree add -q --orphan -b test-artifacts "$wt"
    printf '# Test artifacts\n\nScreenshots referenced from bug reports (automated QA runs). Not code.\n' > "$wt/README.md"
  fi
fi
git -C "$wt" pull -q --rebase origin test-artifacts 2>/dev/null || true
mkdir -p "$wt/$sub"
for f in "$@"; do cp "$f" "$wt/$sub/"; done
git -C "$wt" add -A
git -C "$wt" diff --cached --quiet || git -C "$wt" commit -qm "QA screenshots: $sub"
git -C "$wt" push -q -u origin test-artifacts
for f in "$@"; do echo "https://raw.githubusercontent.com/$slug/test-artifacts/$sub/$(basename "$f")"; done
