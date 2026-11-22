# Changelog

All notable changes to Omega are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Omega uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-22

### Added

- **Multiple windows:** work on several projects at once, each with its own terminals, language servers, Run and Debug.
- **`omega` in the terminal:** `omega .` opens the current folder, `omega <path>` opens a folder or file.
- **Go:** highlighting, gopls, Run, Test, debugging with Delve, one-click setup and a project template.
- **Scala, OCaml and Mojo:** highlighting, language servers, Run, Build, Debug, project templates and one-click install. Mojo needs WSL on Windows. OCaml's one-click install isn't available on Windows yet, but an OCaml you installed yourself works.
- **More file types:** highlighting, comment toggling and indentation for SQL, YAML, Shell, Dockerfile, XML and Makefile.
- **Image and PDF viewer:** open images (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, SVG) and PDFs in a normal tab, with zoom and page navigation.
- **Choose the language of any file:** Run, Debug and the language server follow your choice.
- **Signature help:** see a function's parameters while you type a call, with the current one highlighted.
- **Symbol highlighting:** other uses of the symbol under the cursor are marked.
- **More code navigation:** Go to Implementation, Go to Type Definition and Go to Declaration.
- **Zen mode:** one shortcut hides the interface and centers your text. Escape brings your layout back.
- **Code Together for guests:** shared Run, Debug, Git, search, terminals, packages and language features, with permissions per guest.
- Cheat sheets for Scala, OCaml and Mojo, and reworked sheets for the other languages.
- Keyboard navigation in the file tree.

### Changed

- New Omega logo and app icons.
- New Python projects use plain `uv init`.
- One button in Code mode now shows the language and the language server status, with restart.
- Error messages from the backend and Code Together are translated into your language.
- Shortcut hints across the app follow your configured keymap.
- Programs started from the AppImage get your normal environment.
- Java now uses a pinned language server and needs Java 25 for it. Omega installs JDK 25, and a JDK 21 that Omega installed is replaced by it, so your programs run on 25 too.

### Fixed

- **Editor:** indentation is detected from the file, formatting keeps it, cursor positions are restored, UTF-8 BOMs are kept on save, and many selection, sorting and case commands behave correctly.
- **Files:** no more false "changed on disk" conflicts, deleted files keep their tab and ask before closing, and symlinked folders work in the file tree.
- **LaTeX:** more reliable included files, diagnostics, outline, SyncTeX and PDF panel.
- **Markdown:** fixes for links, images, nested quotes, headings and bold or italic toggles.
- **Find and Replace:** Replace in Files changes exactly the lines Find shows and covers results beyond the display limit.
- **Git:** rebases and merges in progress can be continued or aborted, the behind count stays current, and diffs of renamed, binary and large files are correct.
- **Debugger:** Restart, exception stops, variables and breakpoints across projects work reliably.
- **Language servers:** failed starts and crashes recover cleanly, servers from a previous folder are stopped, and a failed Java project import now shows its reason.
- **Run and Build:** better CMake, TypeScript, JavaScript and Python project detection.
- Many layout, accessibility and translation fixes.

### Security

- **Remote Markdown images:** Omega asks before loading them, so a shared note can't reveal your IP address or when you opened it.
- **Very large files:** Omega warns before opening them, so a huge file can't freeze the app or use up its memory.
- **Code Together:** guests stay inside the shared project, away from `.git` and Git hooks, and can only use the rights the host gives them.
- Rename and New File refuse names that would leave the folder.

## [0.1.0] - 2026-11-20

First public release.

### Added

- **LaTeX** with a live PDF and no TeX installation.
- **Markdown notes** that render as you type, with formulas, tables and callouts.
- **Code mode** with Run, Test, Debug, completion, terminal and Git for Python, Rust, C/C++, Java and JavaScript.
- **Code Together** for live collaboration.
- Spell checking in German, English and French.
- A dockable layout, customizable keyboard shortcuts and the Liquid Glass theme.
- Installers for Windows, macOS and Linux with automatic updates.

[0.2.0]: https://github.com/philippeZim/Omega/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/philippeZim/Omega/releases/tag/v0.1.0
