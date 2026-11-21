#!/usr/bin/env bash
# Copies a QA fixture (dev/fixtures/<name>) to a fresh temp folder and prints its path.
# Usage: dev/qa/fixture.sh <name> [dest-parent]
set -euo pipefail
here="$(cd "$(dirname "$0")/../fixtures" && pwd)"
name="${1:?fixture name: $(ls "$here" | grep -v README | tr '\n' ' ')}"
[ -d "$here/$name" ] || { echo "unknown fixture: $name" >&2; exit 2; }
parent="${2:-${TMPDIR:-/tmp}}"
dest="$(mktemp -d "$parent/omega-qa-$name-XXXX")"
cp -a "$here/$name/." "$dest/"
if [ "$name" = files ]; then
  # Generated, too big for git: a 4.6 MB log file.
  python3 -c "print('\n'.join(f'line {i} '+'x'*80 for i in range(50000)))" > "$dest/big.log"
fi
if [ "$name" = rust-cargo ] || [ "$name" = python-uv ] || [ "$name" = node-pnpm ] || [ "$name" = cmake-c ]; then
  git -C "$dest" init -q && git -C "$dest" add -A && git -C "$dest" -c user.name=qa -c user.email=qa@localhost commit -qm init
fi
echo "$dest"
