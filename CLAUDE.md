@AGENTS.md

## Claude Code

- Talk to the user in German. Work in increments and ask (AskUserQuestion) at every important decision, with a recommended option.
- Orchestrating several agents in parallel (issues → worktrees → workers → review → merge into `dev`): skill `/orchestrate`.
- Debugging the user's own running Omega (not a test instance): Settings → AI → control MCP. The `omega-dev` proxy only targets it when you pass its name explicitly (`instance: "default"`).
