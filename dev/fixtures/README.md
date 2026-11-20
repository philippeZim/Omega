# QA fixtures

Small workspaces for exploratory UI tests (see `dev/qa/`). Testers never work on these
directly: `dev/qa/fixture.sh <name>` copies one to a fresh temp folder and prints its path.

| Fixture | For |
|---|---|
| `markdown` | Live preview, reveal, math, tables, links (also `%`, spaces, umlauts), images, long lines, spellcheck DE/EN/FR |
| `latex` | Tectonic build, `\input` chapters, outline, one deliberate error in `chapters/broken.tex` |
| `rust-cargo` | Cargo build/run/test, rust-analyzer, CodeLLDB breakpoints |
| `python-uv` | uv run/test, pyright/LSP, debugpy |
| `node-pnpm` | pnpm scripts, TypeScript LSP |
| `cmake-c` | CMake configure/build/run (`${PROJECT_NAME}` target, #9) |
| `files` | Explorer: umlauts, spaces, deep nesting, empty folder, symlinks, big file, CRLF, binary |
