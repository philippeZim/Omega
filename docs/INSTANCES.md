# Several instances for AI agents

AI agents (Claude Code, Codex, OpenCode) test their changes in their own Omega instance, driven through the control MCP. Any number of instances run side by side: one per worktree, or several per agent (for example `host` and `guest` for Code Together).

## Setup (once per agent)

The MCP server is `dev/omega-mcp.mjs`, a stdio proxy with no dependencies.

- **Claude Code:** `.mcp.json` in the repo. Start `claude` in the worktree and approve `omega-dev` once.
- **OpenCode:** `opencode.json` in the repo.
- **Codex:** `codex mcp add omega-dev -- node /absolute/path/to/repo/dev/omega-mcp.mjs`. This is one global entry: the proxy works out the worktree from the agent's working directory.

## Tools

| Tool | What it does |
|---|---|
| `instance_launch {name?, paths?, worktree?}` | Runs `cargo build` in `worktree` (default: the agent's working directory; subagents running in the orchestrator's directory pass it), starts its own Vite and the app with `OMEGA_INSTANCE=<name>`, and returns once the control MCP is up. The new instance becomes the default target. |
| `instance_list` | Lists running instances (name, pid, worktree, default target). |
| `instance_stop {name \| "all"}` | Exits cleanly and also stops the instance's Vite. Only instances this worktree launched can be stopped. |
| all app tools (`get_state`, `click`, `screenshot`, …) | Forwarded to the instance. The optional `instance` argument picks a specific one. |

Without an `instance` argument, a call goes to the last launched instance, or to the only one in this worktree. The proxy never picks your own Omega on its own.

From a terminal: `node dev/omega-mcp.mjs list | launch [name] [paths…] | stop <name|all>`.

**Test instances open on desktop 5.** On Hyprland the launcher moves each new instance window to workspace 5 and gives the focus back to the window that had it, so tests never land on the desktop you are working on. `OMEGA_TEST_WORKSPACE=<n>` picks another desktop, and `OMEGA_TEST_WORKSPACE=` turns it off.

## How it works

- `OMEGA_INSTANCE=<name>` (see `src-tauri/src/instance.rs`) gives the instance its own webview data in `<app data>/instances/<name>` (settings, layout, MCP token). The control MCP is always on, on a free port, and the window title is `Omega – <name>`. Installed tools (LSP servers, debuggers) are shared.
- Each instance runs its own Vite on a port derived from worktree and name. The port stays the same across restarts, and so do the instance's settings, since localStorage belongs to the origin.
- Every running control MCP, including the one of a normal Omega, writes port and token to `$XDG_RUNTIME_DIR/omega/instances/<pid>.json` (mode 0600). The proxy reads it on every call, so a new token after a reload causes no trouble.
- Logs: `$XDG_RUNTIME_DIR/omega/logs/<worktree>-<name>.log` (`.vite.log` for Vite).
- Optional environment variables: `OMEGA_MCP_PORT` (fixed MCP port for an instance), `OMEGA_DEV_URL`, `OMEGA_VITE_PORT`, `OMEGA_WORKTREE`.

## New worktrees build fast

On btrfs/XFS, copy the build cache of the main checkout instead of building from scratch. The copy takes about 3 s, uses no extra space, and only Omega's own crate is rebuilt afterwards:

```sh
mkdir -p ../wt/src-tauri/target && cp -a --reflink=always src-tauri/target/debug ../wt/src-tauri/target/
```
