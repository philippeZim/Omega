# Exploratory QA with AI agents

An orchestrating agent sends tester subagents through the running app. Each tester has one area and
its own Omega instance on Hyprland desktop 5. Every finding is then replayed by a fresh verifier
agent. Confirmed bugs that aren't already reported become GitHub issues.

- `CHARTER.md`: rules, tools and output format for testers and verifiers. Give it to every agent.
- `fixture.sh <name> [dir]`: fresh copy of a workspace from `dev/fixtures/`.
- `publish-shots.sh <subdir> <png>…`: pushes screenshots to the `test-artifacts` branch and
  prints raw URLs for issue bodies.
- `node dev/omega-mcp.mjs call [-i instance] [-o shot.png] <tool> [json]`: app tools from a shell.

Control-MCP tools made for this: `ui_audit` (overflow, offscreen, covered, contrast,
unlabeled, i18n) and `set_viewport` (small windows emulated through webview zoom, because test windows
sit on an invisible desktop and can't really be resized). Test instances get a
`requestAnimationFrame` fallback (`src-tauri/src/instance.rs`), since WebKit pauses frames on
invisible desktops.
