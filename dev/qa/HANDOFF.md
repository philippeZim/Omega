# QA handoff: exploratory UI testing with subagents

Status as of 2026-11-20. This file is for the next agent continuing the automated
"manual" QA of Omega: subagents drive the running app like a human tester, find visual and
logical bugs, and file them as GitHub issues. Read `README.md` and `CHARTER.md` in this folder first.

## The user's rules (don't revisit without asking)

- Communicate with the user in **German**; work in increments, ask at real decisions.
- **Test instances only on Hyprland desktop (workspace) 5**, never on the user's desktop.
  `dev/omega-mcp.mjs launch` handles this; never start `pnpm tauri dev` for tests.
- Bugs found → **GitHub issues right away** (no approval round), deduplicated against
  open *and closed* issues. Don't fix bugs inline; that's the orchestrator's job (below).
- Screenshots for issues go to the orphan branch `test-artifacts` (`publish-shots.sh`).
  **Look at every image first**; skip images showing local paths (the username appears in
  `/tmp/claude-1000/-home-<user>-…` and `/home/<user>`). Many shots have such paths in tab
  labels, so text-only issues are fine.
- **No installs** of LSP servers / debug adapters from test instances.
- **No Claude attribution** in commits, PRs or issues (no Co-Authored-By, no "Generated with").
- **Never work directly in `~/Projects/ide`.** Another Claude session ("orchestrator",
  `.claude/skills/orchestrate`) merges issue branches into `dev` there and pushes. Use your own
  worktree (`dev/agent.sh new <name>`), commit there, ask the orchestrator session to
  review/merge (it does code review and asks for tests). Don't use `git stash` (shared by all worktrees).

## Setup that works

1. QA worktree for the testers: a **detached** checkout, so merges into `dev` don't hot-reload
   running test instances:
   ```sh
   git worktree add --detach ../ide-qa dev        # exists already: git -C ../ide-qa checkout --detach <rev>
   mkdir -p ../ide-qa/src-tauri/target && cp -a --reflink=always src-tauri/target/debug ../ide-qa/src-tauri/target/
   ln -s "$PWD/node_modules" ../ide-qa/node_modules
   ```
   Pre-build once (`node dev/omega-mcp.mjs launch qa-prebuild && … stop qa-prebuild`) before
   launching several testers, otherwise they queue on the cargo lock.
2. Testers drive the app through the shell (subagents have no MCP access):
   `node dev/omega-mcp.mjs call -i <instance> <tool> '<json>'` (`-o shot.png` for screenshots,
   `tools <instance>` lists all tools). Each tester gets its **own instance name and a private
   helper script in its run dir**: a shared `q.sh` got overwritten by a parallel tester once.
3. Run dirs: one per area in the session scratchpad (`runs/<area>/findings.json`, `shots/`).
   Tell testers to **write findings.json incrementally**: a network outage killed all four
   wave-2 testers at once. They were resumed via SendMessage and their instances were still running.
4. Filing: write a `spec.json` (finding id → issue title, optional `img` URLs, `extra`
   markdown such as "Related: #NN", `skip`), then `dev/qa/file-issues.py findings.json spec.json`.
   Afterwards grep every new issue body for `/tmp/claude` and `/home/` to make sure no local path leaked.

### Tester brief template (what worked)

"You are an exploratory QA tester for Omega. Work ONLY in `~/Projects/ide-qa`. Read
`dev/qa/CHARTER.md` and follow it. Instance name `qa-<area>`; run dir `…/runs/<area>`; fixture
`dev/qa/fixture.sh <name> <run dir>`; area: <detailed list of features + edge cases + visual
pass (ui_audit, set_viewport width 800/1280, UI language DE and FR once)>; known issues to skip:
<path to `gh issue list --state all` dump>; known tooling limits: <see below>; budget ~60–90
min / ~150 tool calls. At the end stop your instance, write findings.json and reply with the
JSON plus notes (UX suggestions, untested parts and why, tooling problems)."
A fresh **verifier** agent (CHARTER.md, section Verifier) is worth it only for doubtful
findings. markdown-5 → #89 is an example where it found the real root cause.

## What's done

| Area | Issues | Notes |
|---|---|---|
| Explorer / files | #32–#40 | pilot run |
| Markdown | #41–#48, #89 | #89 verified (asset:// `<img>` never reaches Tauri) |
| LaTeX | #49–#58 | |
| Shell / layout / settings / palette | #59–#65 | |
| Git / search | #66–#77 | |
| Code mode: projects, build/run/test, terminal | #78–#88 | |
| Debugger | #101–#107 | |
| LSP | #108–#116 | #108: managed TS server broken (TypeScript 7), affects the user's real Omega |
| Editor core + AI panel (UI only) | #117–#125 | AI panel: no bugs |
| Code Together (two local instances) | #126–#135 | three data-loss bugs |

#90–#100 are from the orchestrator session. Many of the issues above are already **closed**,
i.e. fixed on `dev`, but **not re-tested in the running app** (see next steps).

## Tooling built (on `dev`, or on branch `feat/qa-tooling-2` pending merge)

- `ui_audit` (overflow, offscreen, covered, contrast, unlabeled, i18n), `set_viewport`
  (small windows emulated via webview zoom, because hidden windows can't really be resized),
  `click … right:true`, `call`/`tools` CLI in `dev/omega-mcp.mjs`.
- Test instances: native file dialogs become an in-app prompt, opener (browser, file manager)
  is only logged (`src/lib/native.ts`); `requestAnimationFrame` fallback for invisible
  desktops (`src-tauri/src/instance.rs`).
- `feat/qa-tooling-2` (review fixes done, waiting for the orchestrator to merge):
  - element lookup by reachability (`elementFromPoint`) instead of "last dialog"
  - live `title` before a stale `data-tip`
  - punctuation key codes
  - `type_text` into editor panel inputs
  - `get_state.overlays.report`
  - CHARTER rule against the Control-MCP "Run" button
  - DOM helpers in `src/lib/ai/dom.ts` with tests

## Known tooling limits (tell every tester)

- Screenshots come from html-to-image, not the compositor. They show:
  - no backdrop blur
  - no tooltips
  - frozen CSS transitions
  - no scroll position
  - images re-fetched (they prove nothing about `<img>` loading)

  They fail on control characters (binary diff) and break on broken images. Don't report these artifacts.
- Other instances on desktop 5 make Hyprland retile the test window (e.g. 621×670). Then the
  mode switcher collapses into a menu etc. Use `set_viewport '{"width":1400}'` for a stable layout.
  `set_viewport` keeps the window's aspect ratio (width 800 can give a 323 px high viewport),
  and xterm misaligns under zoom.
- `press_key` sends synthetic keydown only (no real keyboard, no autoclose/multi-cursor typing).
  One tester used `hyprctl dispatch 'hl.dsp.send_shortcut({ … window = "address:0x…" })'` on its
  **own** window for real keys (German layout mapping).
- The app's auto-refresh (git polling) only runs while the window has focus, and test windows never have it.
- `type_text` only writes into the main selection.

## Side effects that are NOT sandboxed yet

- Code Together "start session" copies the invite code to the **user's real clipboard**.
  Other copy actions (Copy Path, …) likely too. Next useful tooling step: route clipboard writes
  through `native.ts` and only log them in instances, like the file dialogs.
- Report button: overwrites the clipboard (when a screenshot is attached) and writes
  `~/Downloads/omega-report-*` → forbidden in CHARTER.
- Settings → AI → Control MCP "Run" writes `claude mcp add --scope user` → forbidden in CHARTER.
- LSP: Go to Definition into Rust std started a rust-analyzer that wrote `target/` into
  `~/.rustup/…/library/` (#109). Clean it up if a test triggers it.
- The instance setting "control MCP" can be switched off by a stray click; relaunch the instance.

## Next steps (not started: the user stopped here)

1. **Clipboard sandbox** for instances (see above), then re-allow Code Together tests freely.
2. **Re-test closed issues** in the running app, one verifier per batch: the list is
   `gh issue list --state closed` with numbers ≥ 32. Reopen the issue with a comment if the
   fix doesn't hold.
3. **Wave 3 areas not covered yet:**
   - spell check in all modes
   - a deep i18n sweep of every dialog in FR/DE
   - performance and scale: big workspace, many tabs, long sessions, memory
   - keyboard-only use: focus order, focus traps in dialogs
   - updater/about UI (no real update), first-run and empty states
   - persistence across restarts: settings, layout, recent folders, session/tab restore (tabs aren't restored today)
4. Tester notes contain many **UX suggestions** that were deliberately not filed as bugs; they
   are in the agents' final replies only. Ask the user whether to collect them as enhancement issues.
