# Omega – rules for AI agents

- **Attribution:** never add an AI as author or contributor (no `Co-Authored-By`, no "Generated with …") in commits, PRs or issues. The user is the only author.
- **Branches:** work on `dev`. Never commit or push to `main`; it only gets released code, and every tag on it builds a release.
- **Fast feedback:** while working, run only the tests for what you touched: `pnpm vitest run <file>`, or `cargo test <name>` in `src-tauri/` if Rust changed. The full `dev/check.sh` (~30 s) is for before a release to `main`.
- **i18n:** every UI text gets a key in `en` and `de` in `src/lib/i18n/strings/<area>.ts` and is used via `t("…")`.
- **No flashing animations:** never animate or transition `transform`/`opacity` on or over `backdrop-filter` glass; WebKitGTK flashes a stale frame. Things appear instantly; colour/shadow fades are fine.
- **Testing the app:** use the `omega-dev` MCP server (`instance_launch`, then `get_state`, `click`, `screenshot` …, finally `instance_stop`). Instances open on desktop 5. Don't run `pnpm tauri dev`. Details: `docs/INSTANCES.md`.
