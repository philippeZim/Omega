import { EditorState } from "@codemirror/state";
import { t, type Key } from "./i18n/index.svelte";

/** CodeMirror's built-in UI phrases (search panel, go to line, folding, lint) → our dictionary keys. */
const CM_PHRASES: [string, Key][] = [
  ["Find", "commands.cm.find"], ["Replace", "commands.cm.replace"], ["next", "commands.cm.next"],
  ["previous", "commands.cm.previous"], ["all", "commands.cm.all"], ["match case", "commands.cm.matchCase"],
  ["regexp", "commands.cm.regexp"], ["by word", "commands.cm.byWord"], ["replace", "commands.cm.replaceOne"],
  ["replace all", "commands.cm.replaceAll"], ["close", "commands.cm.close"], ["Go to line", "commands.cm.gotoLine"],
  ["go", "commands.cm.go"], ["current match", "commands.cm.currentMatch"], ["on line", "commands.cm.onLine"],
  ["replaced match on line $", "commands.cm.replacedOnLine"], ["replaced $ matches", "commands.cm.replacedCount"],
  ["Completions", "commands.cm.completions"], ["Diagnostics", "commands.cm.diagnostics"],
  ["No diagnostics", "commands.cm.noDiagnostics"], ["folded code", "commands.cm.foldedCode"], ["unfold", "commands.cm.unfold"],
  ["Fold line", "commands.cm.foldLine"], ["Unfold line", "commands.cm.unfoldLine"], ["Folded lines", "commands.cm.foldedLines"],
  ["Unfolded lines", "commands.cm.unfoldedLines"], ["to", "commands.cm.to"], ["Control character", "commands.cm.controlChar"],
  ["Selection deleted", "commands.cm.selectionDeleted"],
];

/** Phrases for the current UI language; also for English, whose button labels we capitalise
 *  ("Next", "Match case") unlike CodeMirror's defaults. */
export function phrases() {
  return EditorState.phrases.of(Object.fromEntries(CM_PHRASES.map(([p, k]) => [p, t(k)])));
}
