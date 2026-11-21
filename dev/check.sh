#!/usr/bin/env bash
# All local checks a branch must pass before it is merged into dev (CI only runs for main).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
step "svelte-check";  pnpm -s check
step "vitest";        pnpm -s test
step "cargo test";    (cd src-tauri && cargo test --quiet 2>&1 | grep -vE '^\s*$|^running 0 tests|^test result: ok\. 0 passed; 0 failed;')
step "node --check";  node --check dev/omega-mcp.mjs
printf '\n\033[32mAlle Checks bestanden\033[0m\n'
