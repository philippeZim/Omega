# Omega – rules for AI agents

Omega is a Tauri 2 editor (Svelte 5 + TypeScript frontend in `src/`, Rust backend in `src-tauri/`) with the modes Text, Markdown, LaTeX and Code. These rules apply to every agent (Claude Code, Codex, OpenCode) working on it.

## Branches

- `main`: released code only. Every merge is tagged (`v0.x.y`), and the tag builds the release. **Never commit or push to `main`.**
- `dev`: the integration branch. Issue branches are merged here, by the orchestrator only.
- Issue branches: `fix/<nr>-<slug>` or `feat/<nr>-<slug>`, always branched from `dev`, each in its own worktree (`dev/agent.sh new <nr>`).
- Never use `git stash`: the stash is shared by all worktrees, so parallel agents swap each other's changes. To check a test without your fix, use `git diff > /tmp/<nr>.patch`, `git checkout -- <file>`, run the test, then `git apply /tmp/<nr>.patch`.
- Work only on your own branch, in your own worktree. Rebase on `dev` when the orchestrator says `dev` moved: `git rebase dev`.

## Before you report "done"

1. Run `dev/check.sh`. It runs svelte-check, Vitest, `cargo test` and the proxy syntax check, and all of them must pass. CI only runs for `main`, so this is the only gate before `dev`.
2. Every bug fix gets a test that fails without the fix.
3. Check UI changes in a running instance (see below) and take a screenshot.
4. Make small commits with plain English messages in the style of `git log` ("Build step before Run/Test, …"). **No AI attribution:** no `Co-Authored-By`, no "Generated with".
5. Report: what changed, why, how you checked it (paste the `dev/check.sh` result), and anything you had to leave open.

## Testing in the running app

- Use the `omega-dev` MCP server (`dev/omega-mcp.mjs`, configured in `.mcp.json` / `opencode.json`). Start with `instance_launch`, then use `get_state`, `click`, `type_text`, `press_key`, `screenshot` and the other app tools. Finish with `instance_stop`.
- Test instances open on **desktop 5** (Hyprland), never on the user's desktop. Don't move them elsewhere.
- **Don't run `pnpm tauri dev`** in a worktree: it needs port 1420 and collides with other agents. `instance_launch` gives every instance its own ports and settings.
- Several instances are fine, e.g. `host` and `guest` for Code Together. Pass `instance` to choose one.
- Details: `docs/INSTANCES.md`.

## Avoiding conflicts with parallel agents

- Keep the change small and limited to your issue: no drive-by refactorings, no reformatting.
- Hot spots that many tasks touch: `src/lib/state.svelte.ts`, `src/App.svelte`, `src/lib/i18n/strings/*`, `src/lib/layout.svelte.ts`, `src-tauri/src/lib.rs` (command list). Change them only where you have to. In `i18n` files, add keys at the end of the matching block.
- If you need to change an interface another task depends on (a Tauri command signature, a shared store), stop and ask the orchestrator first.

## Code conventions

- Code comments and commit messages in English.
- Every UI text goes through i18n: add the key to `en` and `de` in `src/lib/i18n/strings/<area>.ts` and use `t("…")`.
- Frontend tests are Vitest (`*.test.ts` next to the code; the Tauri IPC mock is in `src/test/`). Rust tests are `#[cfg(test)]` modules in the same file.
- If you find a bug outside your issue, don't fix it on the side. Report it: the orchestrator files it as a GitHub issue after checking for duplicates.
