import { EditorView } from "@codemirror/view";

/** Prose modes get a centered, readable column (like Obsidian's "readable line length");
 *  width is the "Text width" setting. "&.cm-editor" outranks the generic ".cm-content" padding of
 *  baseTheme, which comes first in the editor's extensions. */
export const proseLayout = EditorView.theme({
  "&.cm-editor .cm-content": { maxWidth: "var(--prose-width, 1000px)", margin: "0 auto", padding: "48px 32px 40vh" },
});

export const baseTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--label)", fontSize: "var(--code-font-size, 14px)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.65", overflow: "auto" },
    "&.mode-text .cm-scroller, &.mode-markdown .cm-scroller": { fontFamily: "var(--font)", fontSize: "var(--prose-font-size, 16px)", lineHeight: "1.7" },
    ".cm-content": { caretColor: "var(--accent)", padding: "12px 0 30vh" },
    "&.mode-code .cm-content, &.mode-latex .cm-content": { color: "var(--syn-plain)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: "rgba(107, 155, 224,0.32) !important" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--label-3)", border: "none", paddingLeft: "8px" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 6px", minWidth: "36px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--label-2)" },
    ".cm-activeLine": { backgroundColor: "rgba(var(--fg-rgb), 0.035)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(216, 194, 122,0.16)" },
    ".cm-matchingBracket": { backgroundColor: "rgba(var(--fg-rgb), 0.1)", outline: "1px solid rgba(var(--fg-rgb), 0.25)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--fill)", border: "none", color: "var(--label-2)", borderRadius: "4px", padding: "0 6px" },
    ".cm-foldGutter .cm-gutterElement": { color: "var(--label-3)", cursor: "default" },
    ".cm-panels": { backgroundColor: "rgba(0,0,0,0.25)", color: "var(--label)", border: "none" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid rgba(var(--fg-rgb), 0.05)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid rgba(var(--fg-rgb), 0.05)" },
    // Find/Replace and Go to Line: app font, one size for labels, inputs and buttons (CodeMirror's
    // defaults shrink fields and buttons to 70 %), labels kept on one line.
    ".cm-panel.cm-search, .cm-dialog": { fontFamily: "var(--font)", fontSize: "13px", padding: "8px 40px 8px 12px", position: "relative" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label, .cm-dialog input, .cm-dialog button, .cm-dialog label": { fontFamily: "var(--font)", fontSize: "12px" },
    ".cm-panel.cm-search label, .cm-dialog label": { whiteSpace: "nowrap", color: "var(--label-2)" },
    ".cm-dialog label": { fontSize: "13px" },
    ".cm-panel.cm-search input[type=checkbox]": { accentColor: "var(--accent)", verticalAlign: "middle" },
    ".cm-textfield": { background: "var(--recess)", boxShadow: "var(--recess-shadow)", border: "none", borderRadius: "999px", padding: "5px 12px", color: "var(--label)", fontSize: "12px", outline: "none" },
    ".cm-textfield::placeholder": { color: "var(--label-3)" },
    ".cm-dialog .cm-textfield": { width: "8em", margin: "0 8px 0 4px" },
    ".cm-button": { backgroundImage: "none", background: "rgba(var(--fg-rgb), 0.08)", border: "none", borderRadius: "999px", color: "var(--label)", padding: "4px 12px", fontSize: "12px", cursor: "pointer" },
    ".cm-button:hover": { background: "rgba(var(--fg-rgb), 0.14)" },
    // CodeMirror's "&dark .cm-button" gradient and border outrank a plain ".cm-button".
    "&.cm-editor .cm-panels .cm-button, &.cm-editor .cm-panels .cm-textfield": { backgroundImage: "none", border: "none" },
    // Close ×: a round 24px target instead of a bare 9×16 px glyph.
    ".cm-panel.cm-search button[name=close], .cm-dialog button.cm-dialog-close": {
      position: "absolute", top: "50%", right: "8px", transform: "translateY(-50%)", width: "24px", height: "24px", padding: "0", margin: "0",
      display: "grid", placeItems: "center", border: "none", borderRadius: "50%", background: "transparent", color: "var(--label-2)", fontSize: "18px", lineHeight: "1", cursor: "pointer",
    },
    ".cm-panel.cm-search button[name=close]": { top: "8px", transform: "none" },
    ".cm-panel.cm-search button[name=close]:hover, .cm-dialog button.cm-dialog-close:hover": { background: "var(--fill-hover)", color: "var(--label)" },
    // Find highlights: colours from the --find-* tokens in app.css (issue #301).
    ".cm-searchMatch": { backgroundColor: "var(--find-bg)", color: "var(--find-fg)", boxShadow: "var(--find-shadow)", textDecoration: "var(--find-deco)", textUnderlineOffset: "3px", borderRadius: "2px" },
    ".cm-searchMatch-selected": { backgroundColor: "var(--find-bg-sel)", color: "var(--find-fg-sel)", boxShadow: "var(--find-shadow-sel)" },
    ".cm-tooltip": { backgroundColor: "var(--glass-strong)", backdropFilter: "var(--blur)", border: "none", borderRadius: "14px", boxShadow: "var(--glass-highlight), 0 14px 40px rgba(0,0,0,0.6)", overflow: "hidden", padding: "4px" },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "13px", maxHeight: "18em" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px !important", borderRadius: "8px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "white" },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #df7067", textUnderlineOffset: "3px" },
    ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy #d6a35f", textUnderlineOffset: "3px" },
    ".cm-tooltip-lint": { padding: "6px 10px" },
    ".cm-diagnostic": { borderLeft: "none", padding: "2px 4px", fontFamily: "var(--font)", fontSize: "12.5px" },
    ".cm-diagnostic-error": { color: "#e3aaa4" },
    ".cm-diagnostic-warning": { color: "#e0c59a" },
    // Quick-fix buttons in the diagnostic tooltip (e.g. "Include <stdio.h>"): neutral glass pills.
    ".cm-diagnosticAction": { display: "inline-block", margin: "6px 6px 0 0", padding: "3px 10px", border: "none", borderRadius: "999px", font: "600 12px var(--font)", color: "var(--label)", backgroundColor: "rgba(var(--fg-rgb), 0.1)", boxShadow: "inset 0 1px 0 rgba(var(--hl-rgb), 0.1)", cursor: "pointer" },
    ".cm-diagnosticAction:hover": { backgroundColor: "rgba(var(--fg-rgb), 0.18)" },
    ".cm-completionDetail": { color: "var(--label-2)", fontStyle: "normal", marginLeft: "1em" },
  },
  { dark: true },
);

import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Syntax colours come from CSS variables (--syn-*), set by the chosen preset (see syntaxThemes.ts). */
export const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.character, t.escape], color: "var(--syn-number)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.definition(t.variableName), t.definition(t.function(t.variableName))], color: "var(--syn-definition)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.processingInstruction, t.meta, t.annotation], color: "var(--syn-preproc)" },
  { tag: [t.self, t.special(t.variableName)], color: "var(--syn-keyword)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--syn-operator)" },
  { tag: t.tagName, color: "var(--syn-keyword)" },
  { tag: t.invalid, color: "var(--syn-invalid)" },
]);
