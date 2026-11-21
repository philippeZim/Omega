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
import { Highlight, InlineMath, BlockMath, WikiLink } from "./markdown/syntax";
import { livePreview } from "./markdown/livePreview";
import { codeHighlight, proseLayout } from "./theme";
import { latexExtensions } from "./latex/language";
import { langFor, indentFor } from "./code/languages";
import { lspExtension } from "./code/lspExtension";
import { remoteLsp } from "./code/remoteLsp";
import { debugExtension } from "./debug/editorExt";
import { gitGutter } from "./git/gutter";
import { gitBlame } from "./git/blame.svelte";

export { MODES, type Mode } from "./modeList";
import type { Mode } from "./modeList";

const CODE_EXT = new Set(["py", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "java", "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "rs", "toml", "json"]);

/** Returns a mode only for extensions that clearly belong to one; unknown files keep the current mode. */
export function modeForExtension(ext: string): Mode | null {
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "tex" || ext === "bib" || ext === "sty" || ext === "cls") return "latex";
  if (CODE_EXT.has(ext)) return "code";
  if (ext === "txt") return "text";
  return null;
}

const markdownLang = markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Highlight, InlineMath, BlockMath, WikiLink] });

export function modeExtensions(mode: Mode, rawPath: string | null): Extension {
  // Shared files of a collab session (guest side): highlighting by extension, language
  // intelligence from the host's server, no debugger or git – those run on the host.
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
        rawPath ? gitBlame(rawPath) : [],
        rawPath ? gitGutter(rawPath) : [],
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
        rawPath && lang?.server ? debugExtension(rawPath) : [],
        rawPath ? gitBlame(rawPath) : [],
        rawPath ? gitGutter(rawPath) : [],
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
        lang?.server && path ? lspExtension(path, lang) : (lang?.server && remote && remoteLsp.extension?.(rawPath!.slice("collab:".length))) || autocompletion(),
        EditorView.editorAttributes.of({ class: "mode-code" }),
      ];
    }
  }
}
