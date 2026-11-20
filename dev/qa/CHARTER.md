# Exploratory QA: charter for tester and verifier agents

You test the running Omega app like a careful human tester and report bugs as structured
findings. You do **not** fix code. The orchestrator turns verified findings into GitHub issues.

## Hard rules

1. **Only your own instance, only on desktop 5.** Start it with
   `node dev/omega-mcp.mjs launch <your-instance> <fixture-path>` (it builds, opens the window on
   Hyprland workspace 5 and gives the focus back). Never run `pnpm tauri dev` yourself, never touch
   the user's own Omega, never `pkill`. Stop it at the end: `node dev/omega-mcp.mjs stop <your-instance>`.
2. **Only fixture copies.** Get a workspace with `dev/qa/fixture.sh <name> <scratch-dir>`; never
   open the repo itself or anything in `$HOME` as the workspace.
3. **Native windows are sandboxed in instances:** file dialogs (Open Folder, Save As, …) appear
   as an in-app prompt titled "Native dialog (…)": type an absolute path and press Enter.
   Opening URLs or revealing files only logs `[instance] would open: …` (console + toast).
   If any other window still appears outside workspace 5, close it immediately
   (`hyprctl dispatch 'hl.dsp.window.close({ window = "address:0x…" })'`) and report it as a tooling problem.
4. **Forbidden actions:** installing LSP servers/debug adapters (install dialogs: screenshot them,
   then cancel), "Check for updates"/updater,
   logging in to Codex/Claude/OpenCode, collab with external tickets, `git push`, editing files
   in the repo (`src/`, `src-tauri/`, …).
5. Don't trigger `alert/confirm` browser dialogs; in-app dialogs are fine.

## Driving the app (shell)

```
Q() { node dev/omega-mcp.mjs call -i <your-instance> "$@"; }
Q get_state                                   # mode, tabs, overlays, dialog, terminal, toasts
Q query_ui '{"text":"Open Folder"}'           # find controls (label, rect)
Q click '{"text":"New File"}'                 # by text / aria-label / tooltip / selector
Q click '{"text":"a.txt","right":true}'       # right-click → context menu (then click its item)
Q type_text '{"text":"hello"}' ; Q press_key '{"key":"s","ctrl":true}'
Q run_command '{"id":"…"}' ; Q list_commands '{"filter":"terminal"}'
Q screenshot '{}' -o <run-dir>/shots/017-after-save.png   # then look at it with Read
Q ui_audit '{}'                               # overflow, offscreen, covered, contrast, unlabeled, i18n
Q set_viewport '{"width":800}'                # emulate a narrow window (height follows the wide monitor ratio);
                                              # '{"height":600}' for a low one; '{}' resets
Q get_console '{"level":"error"}'
Q read_file '{"path":"…"}' ; Q get_editor_text '{}'
Q terminal_run '{"command":"ls"}' ; Q terminal_read '{}'
```

`node dev/omega-mcp.mjs tools <your-instance>` lists all tools with their arguments; `list_commands`
shows every command id; `query_ui` without arguments lists all visible controls. Screenshots
default to scale 1 — don't judge visuals from scaled-down shots (they show artifacts).
`press_key` dispatches synthetic keydown events (good for shortcuts, not a real keyboard).
Screenshots that may be published must not show paths outside the fixture: prefer element
screenshots (`{"selector":…}`) over menus that list absolute paths.

## How to test

- Work through your **area** (given in your task) systematically: every visible control, every
  command of the area, every dialog, then edge cases (empty input, very long names, umlauts and
  spaces, cancel half-way, repeat quickly, undo, reload state).
- **After every meaningful action** check the invariants:
  - `get_console {"level":"error"}` has no new errors,
  - `get_state` matches what you expect (tabs, dirty flags, dialogs closed, toasts),
  - files on disk (`read_file` / `ls` on the fixture) match the editor after saving,
  - the UI still reacts (no hang: a tool call that times out is a finding).
- **Visual pass** per screen/state: screenshot + look at it (cut-off text, misaligned or
  overlapping elements, inconsistent spacing, broken glass theme, empty or black panels, wrong
  icons) and `ui_audit`. Repeat key screens at `set_viewport` width 800 and 1280, and once with
  the UI language set to Deutsch and Français (Settings), since untranslated text is a bug.
- Logical bugs count as much as visual ones: wrong results, lost data, wrong file written,
  state that doesn't survive a reload, commands available where they make no sense.
- Before reporting, **reproduce once yourself** from a clean state and minimise the steps.
- Skip anything already covered by the known issues listed in your task.

## Output

Write `<run-dir>/findings.json` (array) and end your reply with the same JSON. One entry per bug:

```json
{
  "id": "<area>-<n>",
  "title": "Short bug title in English, like '[Bug] …' issues (without the prefix)",
  "area": "explorer",
  "type": "visual | logic | crash | hang | i18n | a11y | perf",
  "severity": "high | medium | low",
  "steps": ["fixture: files", "Q click '{\"text\":\"New File\"}'", "…"],
  "expected": "…",
  "actual": "…",
  "evidence": { "screenshots": ["<run-dir>/shots/…png"], "console": "…", "audit": "…" },
  "suspected_code": "src/…:line (optional, only if you looked)",
  "confidence": "reproduced 2/2"
}
```

Also list non-bugs you noticed (UX suggestions) under a separate key `"notes"` in your reply,
not in findings.json.

## Verifier

A verifier gets one finding's `steps`, `expected` and `actual` but not the tester's reasoning. It starts a
**fresh** instance on a **fresh** fixture copy, replays the steps three times and answers:

```json
{ "id": "…", "reproduced": "3/3", "verdict": "confirmed | flaky | not-reproduced | not-a-bug",
  "notes": "…", "root_cause": "src/…:line + one sentence (look at the code)", "screenshots": ["…"] }
```
