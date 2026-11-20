import type { Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLineGutter, highlightActiveLine } from "@codemirror/view";
import { foldGutter, indentOnInput, bracketMatching, foldKeymap } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { keymap } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Prec } from "@codemirror/state";
import { lintGutter } from "@codemirror/lint";
import { Highlight, InlineMath, BlockMath } from "./markdown/syntax";
import { livePreview } from "./markdown/livePreview";
import { codeHighlight } from "./theme";
import { latexExtensions } from "./latex/language";
import { langFor, indentFor } from "./code/languages";
import { lspExtension } from "./code/lspExtension";
import { debugExtension } from "./debug/editorExt";
import { gitGutter } from "./git/gutter";
import { gitBlame } from "./git/blame.svelte";
import { t } from "./i18n/index.svelte";

export type Mode = "text" | "markdown" | "latex" | "code";

export const MODES: { id: Mode; label: string }[] = [
  { id: "text", get label() { return t("app.mode.text"); } },
  { id: "markdown", label: "Markdown" },
  { id: "latex", label: "LaTeX" },
  { id: "code", label: "Code" },
];

const CODE_EXT = new Set(["py", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "java", "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "rs", "toml", "json"]);

/** Returns a mode only for extensions that clearly belong to one; unknown files keep the current mode. */
export function modeForExtension(ext: string): Mode | null {
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "tex" || ext === "bib" || ext === "sty" || ext === "cls") return "latex";
  if (CODE_EXT.has(ext)) return "code";
  if (ext === "txt") return "text";
  return null;
}

/** Prose modes get a centered, readable column (like Obsidian's "readable line length");
 *  width is the "Text width" setting. */
const proseLayout = EditorView.theme({
  ".cm-content": { maxWidth: "var(--prose-width, 1000px)", margin: "0 auto", padding: "48px 32px 40vh" },
});

const markdownLang = markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Highlight, InlineMath, BlockMath] });

export function modeExtensions(mode: Mode, rawPath: string | null): Extension {
  // Shared files of a collab session (guest side): highlighting by extension, but no LSP,
  // debugger or git – those run on the host.
  const remote = !!rawPath && rawPath.startsWith("collab:");
  const path = remote ? null : rawPath;
  switch (mode) {
    case "text":
      return [EditorView.lineWrapping, proseLayout, EditorView.editorAttributes.of({ class: "mode-text" })];
    case "markdown":
      return [
        EditorView.lineWrapping,
        proseLayout,
        markdownLang,
        syntaxHighlighting(codeHighlight),
        livePreview(path),
        Prec.high(keymap.of(markdownKeymap)),
        EditorView.editorAttributes.of({ class: "mode-markdown" }),
      ];
    case "latex":
      return [
        EditorView.lineWrapping,
        path ? gitBlame(path) : [],
        path ? gitGutter(path) : [],
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        bracketMatching(),
        closeBrackets(),
        keymap.of([...closeBracketsKeymap, ...completionKeymap]),
        latexExtensions(path),
        EditorView.editorAttributes.of({ class: "mode-latex" }),
      ];
    case "code": {
      const lang = langFor(rawPath);
      return [
        path && lang?.server ? debugExtension(path) : [],
        path ? gitBlame(path) : [],
        path ? gitGutter(path) : [],
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        keymap.of([...closeBracketsKeymap, ...foldKeymap, ...completionKeymap]),
        lang ? lang.ext() : [],
        indentFor(lang),
        syntaxHighlighting(codeHighlight),
        lintGutter(),
        lang?.server && path ? lspExtension(path, lang) : autocompletion(),
        EditorView.editorAttributes.of({ class: "mode-code" }),
      ];
    }
  }
}
