# Changelog

All notable changes to Omega are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Omega uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-26

### Added

- **Editor splits and tab groups:** split the editor right or down from the tab menu, with a shortcut or by dragging a tab to a group's edge. The same file can be open in several groups, each with its own cursor and mode. The layout is restored with your session.
- **Files from outside into the explorer:** drop files from your file manager onto the file tree, or copy and paste them. A clipboard image is saved as a PNG, and files copied in the explorer paste in your file manager too.

### Changed

- Ctrl+F options (match case, regular expression, by word) are pill toggles that fit the rest of the interface.
- Find highlights all matches in solid blue and the current match in white, so they are easier to spot.
- The PDF viewer uses pdf.js 6, and Omega's downloads of languages and tools use an updated HTTP client.

### Fixed

- **Smooth scrolling:** mouse wheel scrolling is smooth and steady in all modes, line numbers no longer flicker, and formulas and tables no longer make the view jump.
- Every tab keeps its mode when you switch between tabs.
- The file tree opens folders and scrolls to the active file, also when you open it with Ctrl+P.

### Security

- **Strict Content Security Policy:** the app only runs its own scripts and only connects to the package registries it needs.
- **Narrower file access:** the app's file protocol serves files from the open project and the LaTeX output; anywhere else it only serves images.

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
