// Dev-only harness: renders the Markdown mode in a plain browser for visual testing.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../src/app.css";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { modeExtensions } from "../src/lib/modes";
import { baseTheme } from "../src/lib/theme";

const doc = `# Überschrift eins
Ein Absatz mit **fettem**, *kursivem*, ~~durchgestrichenem~~ und ==markiertem== Text sowie \`inline code\`.
Ein [Link zu Obsidian](https://obsidian.md) und eine Formel $E = mc^2$ im Satz.

## Listen
- Erster Punkt
- Zweiter Punkt
  - Verschachtelt
- [ ] Offene Aufgabe
- [x] Erledigte Aufgabe

1. Nummeriert
2. Zweitens

> Ein Zitat über
> zwei Zeilen

---

\`\`\`rust
fn main() {
    println!("Hallo {}", 42); // Kommentar
}
\`\`\`

| Name | Alter | Stadt |
| ---- | ----: | :---: |
| Anna | 31 | **Berlin** |
| Ben | 27 | Köln |

$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

### Dritte Ebene
Letzter Absatz.
`;

const mode = (new URLSearchParams(location.search).get("mode") as any) || "markdown";
const texDoc = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\section{Einleitung}
Eine Formel $\\frac{a}{b} + \\sqrt{x}$ im Text.
\\begin{align}
  f(x) &= x^2 \\\\
  g(x) &= \\int_0^x t\\,dt
\\end{align}
\\subsection{Mehr}
\\label{sec:mehr} Siehe \\ref{}
\\end{document}
`;
const view = new EditorView({
  parent: document.getElementById("host")!,
  state: EditorState.create({ doc: mode === "latex" ? texDoc : doc, extensions: [history(), drawSelection(), baseTheme, modeExtensions(mode, "/tmp/x." + (mode === "latex" ? "tex" : "md"))] }),
});
(window as any).view = view;
if (mode === "markdown") view.dispatch({ selection: { anchor: doc.indexOf("Letzter") } });
