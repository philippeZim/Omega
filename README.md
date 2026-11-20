<p align="center">
  <img src="docs/logo.png" width="112" alt="">
</p>

<h1 align="center">Studio</h1>

<p align="center">
  Notes, LaTeX and code. One app, one window, the whole semester.<br><br>
  <a href="https://github.com/philippeZim/Omega/releases/latest"><b>Download</b></a> ·
  <a href="#install">Install</a> ·
  <a href="https://github.com/philippeZim/Omega/issues">Feedback</a>
</p>

<br>

![LaTeX source next to the live PDF](docs/screenshots/latex.png)

Lecture notes in Obsidian, the exercise sheet in Overleaf, the programming assignment in VS Code. Studio replaces all three, and switching between them is just `Ctrl+1` to `Ctrl+4`.

### LaTeX without the setup

Type on the left, the PDF updates on the right. No TeX distribution to install, no compile button, and `Ctrl+J` jumps straight to the line you're looking at.

### Notes that look finished while you write them

Formulas, tables and callouts render as you type. The Markdown only shows up on the line you're editing.

![Markdown notes with rendered math and a callout](docs/screenshots/markdown.png)

### A real IDE when it's time to code

Run, test and debug Python, Rust, C/C++, Java and JavaScript, with completion, a terminal and Git built in. Whatever a language needs gets set up the first time you open a file.

![Python in the editor, output in the terminal](docs/screenshots/code.png)

And a few things you'll be glad about later: live collaboration with a classmate, spell checking in German, English and French, Claude Code / Codex / OpenCode in the terminal, and `F1` for a cheat sheet in every mode.

## Install

Download Studio for your system from the [latest release](https://github.com/philippeZim/Omega/releases/latest): `.exe` for Windows, `.dmg` for macOS, `.AppImage` for Linux.

The app isn't signed yet, so the first start needs one extra click: *More info → Run anyway* on Windows, *right-click → Open* on macOS. After that Studio keeps itself up to date.

## Feedback

Something broken or missing? Hit the speech-bubble button in the top bar. It turns your description and a screenshot into a GitHub issue in a few seconds.

## Build from source

```sh
pnpm install
pnpm tauri dev
```

You need Rust, Node.js and pnpm (plus the WebKitGTK packages on Linux, see the [Tauri prerequisites](https://tauri.app/start/prerequisites/)). How releases work is described in [docs/RELEASING.md](docs/RELEASING.md).

## License

[GPL-3.0](LICENSE). The bundled spell-checking dictionaries keep their own licenses.
