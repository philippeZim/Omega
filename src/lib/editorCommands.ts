/** Customizable editor commands (run on the active CodeMirror view). */
import { EditorSelection, type StateCommand } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import {
  addCursorAbove, addCursorBelow, selectLine, selectParentSyntax, cursorMatchingBracket, copyLineDown, copyLineUp,
  moveLineUp, moveLineDown, deleteLine, insertBlankLine, toggleComment, toggleBlockComment, undoSelection,
  indentMore, indentLess, selectAll, undo, redo,
} from "@codemirror/commands";
import { selectNextOccurrence, selectSelectionMatches, gotoLine, openSearchPanel } from "@codemirror/search";
import { foldCode, unfoldCode, foldAll, unfoldAll } from "@codemirror/language";
import { startCompletion } from "@codemirror/autocomplete";
import { toggleWrap, insertLink } from "./markdown/livePreview";
import { runViewAction } from "./editorActions";
import type { Mode } from "./modes";

/** Command group ids; the shown label is `commands.group.<id>`. */
export type CommandGroup =
  | "general" | "window" | "search" | "files" | "git" | "collab" | "ai" | "terminal" | "run" | "latex"
  | "selection" | "lines" | "edit" | "navigation" | "code" | "debugger" | "markdown";

/** The label is looked up as `commands.cmd.<id>`. */
export interface EditorCommand {
  id: string;
  group: CommandGroup;
  keys: string[];
  run: Command;
  /** Only active in these modes (default: all). */
  modes?: Mode[];
}

/** Puts a cursor at the end of every line touched by the selection (multi-line editing). */
const cursorsAtLineEnds: Command = (view) => {
  const { state } = view;
  const ranges = [];
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number, last = state.doc.lineAt(r.to).number;
    for (let l = first; l <= last; l++) ranges.push(EditorSelection.cursor(state.doc.line(l).to));
  }
  if (ranges.length < 2) return false;
  view.dispatch({ selection: EditorSelection.create(ranges) });
  return true;
};

/** New empty line above the current one, cursor moves there. */
const insertLineAbove: Command = (view) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => {
      const line = state.doc.lineAt(r.head);
      const indent = /^\s*/.exec(line.text)![0];
      return { changes: { from: line.from, insert: indent + state.lineBreak }, range: EditorSelection.cursor(line.from + indent.length) };
    }),
  );
  return true;
};

/** Duplicates the selection (or the line if nothing is selected). */
const duplicate: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.every((r) => r.empty)) return copyLineDown(view);
  view.dispatch(state.changeByRange((r) => ({ changes: { from: r.to, insert: state.sliceDoc(r.from, r.to) }, range: EditorSelection.range(r.to, r.to + (r.to - r.from)) })));
  return true;
};

/** Joins the next line onto the current one. */
const joinLines: Command = (view) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => {
      const line = state.doc.lineAt(r.head);
      if (line.number >= state.doc.lines) return { range: r };
      const next = state.doc.line(line.number + 1);
      const lead = /^\s*/.exec(next.text)![0].length;
      return { changes: { from: line.to, to: next.from + lead, insert: " " }, range: EditorSelection.cursor(line.to) };
    }),
  );
  return true;
};

const sortLines: Command = (view) => {
  const { state } = view;
  const r = state.selection.main;
  const from = state.doc.lineAt(r.from).from, to = state.doc.lineAt(r.to).to;
  if (from === to) return false;
  const sorted = state.sliceDoc(from, to).split("\n").sort((a, b) => a.localeCompare(b)).join("\n");
  view.dispatch({ changes: { from, to, insert: sorted } });
  return true;
};

const changeCase = (upper: boolean): Command => (view) => {
  view.dispatch(view.state.changeByRange((r) => {
    const text = view.state.sliceDoc(r.from, r.to);
    return { changes: { from: r.from, to: r.to, insert: upper ? text.toUpperCase() : text.toLowerCase() }, range: r };
  }));
  return true;
};

const sc = (c: StateCommand): Command => (view: EditorView) => c(view);

export const EDITOR_COMMANDS: EditorCommand[] = [
  // Multi-cursor & selection
  { id: "editor.selectNextOccurrence", group: "selection", keys: ["Mod-d"], run: sc(selectNextOccurrence) },
  { id: "editor.selectAllOccurrences", group: "selection", keys: ["Mod-Shift-l"], run: sc(selectSelectionMatches) },
  { id: "editor.addCursorAbove", group: "selection", keys: ["Mod-Alt-ArrowUp"], run: addCursorAbove },
  { id: "editor.addCursorBelow", group: "selection", keys: ["Mod-Alt-ArrowDown"], run: addCursorBelow },
  { id: "editor.cursorsAtLineEnds", group: "selection", keys: ["Shift-Alt-i"], run: cursorsAtLineEnds },
  { id: "editor.undoSelection", group: "selection", keys: ["Mod-u"], run: undoSelection },
  { id: "editor.expandSelection", group: "selection", keys: ["Shift-Alt-ArrowRight"], run: selectParentSyntax },
  { id: "editor.selectLine", group: "selection", keys: ["Mod-l"], run: selectLine },
  { id: "editor.selectAll", group: "selection", keys: ["Mod-a"], run: selectAll },

  // Lines
  { id: "editor.moveLineUp", group: "lines", keys: ["Alt-ArrowUp"], run: moveLineUp },
  { id: "editor.moveLineDown", group: "lines", keys: ["Alt-ArrowDown"], run: moveLineDown },
  { id: "editor.copyLineUp", group: "lines", keys: ["Shift-Alt-ArrowUp"], run: copyLineUp },
  { id: "editor.copyLineDown", group: "lines", keys: ["Shift-Alt-ArrowDown"], run: copyLineDown },
  { id: "editor.duplicate", group: "lines", keys: ["Mod-Shift-d"], run: duplicate },
  { id: "editor.deleteLine", group: "lines", keys: ["Mod-Shift-k"], run: deleteLine },
  { id: "editor.insertLineBelow", group: "lines", keys: ["Mod-Enter"], run: insertBlankLine },
  { id: "editor.insertLineAbove", group: "lines", keys: ["Mod-Shift-Enter"], run: insertLineAbove },
  { id: "editor.joinLines", group: "lines", keys: ["Mod-Shift-j"], run: joinLines },
  { id: "editor.sortLines", group: "lines", keys: ["F6"], run: sortLines },
  { id: "editor.indentMore", group: "lines", keys: ["Mod-BracketRight"], run: indentMore },
  { id: "editor.indentLess", group: "lines", keys: ["Mod-BracketLeft"], run: indentLess },

  // Editing
  // In shared files undo only your own changes (Yjs undo manager), never the others'.
  { id: "editor.undo", group: "edit", keys: ["Mod-z"], run: (v) => runViewAction(v, "collab.undo") || undo(v) },
  { id: "editor.redo", group: "edit", keys: ["Mod-y", "Mod-Shift-z"], run: (v) => runViewAction(v, "collab.redo") || redo(v) },
  { id: "editor.toggleComment", group: "edit", keys: ["Mod-/", "Mod-Backslash"], run: toggleComment },
  { id: "editor.toggleBlockComment", group: "edit", keys: ["Shift-Alt-a"], run: toggleBlockComment },
  { id: "editor.upperCase", group: "edit", keys: ["Mod-Shift-u"], run: changeCase(true) },
  { id: "editor.lowerCase", group: "edit", keys: ["Mod-Alt-u"], run: changeCase(false) },
  { id: "editor.complete", group: "edit", keys: ["Mod-Space"], run: startCompletion },

  // Navigation
  { id: "editor.find", group: "navigation", keys: ["Mod-f", "Mod-h"], run: openSearchPanel },
  { id: "editor.gotoLine", group: "navigation", keys: ["Mod-g"], run: gotoLine },
  { id: "editor.matchingBracket", group: "navigation", keys: ["Mod-Shift-Backslash", "Mod-m"], run: cursorMatchingBracket },
  { id: "editor.fold", group: "navigation", keys: ["Mod-Shift-BracketLeft"], run: foldCode },
  { id: "editor.unfold", group: "navigation", keys: ["Mod-Shift-BracketRight"], run: unfoldCode },
  { id: "editor.foldAll", group: "navigation", keys: ["Mod-Alt-BracketLeft"], run: foldAll },
  { id: "editor.unfoldAll", group: "navigation", keys: ["Mod-Alt-BracketRight"], run: unfoldAll },

  // Code (contributed by LSP / debugger extensions of the active view)
  { id: "lsp.gotoDefinition", group: "code", keys: ["F12"], run: (v) => runViewAction(v, "lsp.gotoDefinition"), modes: ["code"] },
  { id: "lsp.format", group: "code", keys: ["Shift-Alt-f", "Mod-Alt-l"], run: (v) => runViewAction(v, "lsp.format"), modes: ["code"] },
  { id: "lsp.quickFix", group: "code", keys: ["Mod-."], run: (v) => runViewAction(v, "lsp.quickFix"), modes: ["code"] },
  { id: "debug.toggleBreakpoint", group: "debugger", keys: ["Mod-F8"], run: (v) => runViewAction(v, "debug.toggleBreakpoint"), modes: ["code"] },

  // Markdown
  { id: "md.bold", group: "markdown", keys: ["Mod-b"], run: toggleWrap("**"), modes: ["markdown"] },
  { id: "md.italic", group: "markdown", keys: ["Mod-i"], run: toggleWrap("*"), modes: ["markdown"] },
  { id: "md.code", group: "markdown", keys: ["Mod-e"], run: toggleWrap("`"), modes: ["markdown"] },
  { id: "md.strike", group: "markdown", keys: ["Mod-Shift-x"], run: toggleWrap("~~"), modes: ["markdown"] },
  { id: "md.highlight", group: "markdown", keys: ["Mod-Shift-h"], run: toggleWrap("=="), modes: ["markdown"] },
  { id: "md.link", group: "markdown", keys: ["Mod-k"], run: insertLink, modes: ["markdown"] },
];

/** The underlying CodeMirror functions, so the default keymaps can drop their own bindings for them. */
export const REGISTERED_RUNS = new Set<unknown>([
  selectNextOccurrence, selectSelectionMatches, addCursorAbove, addCursorBelow, undoSelection, selectParentSyntax, selectLine,
  selectAll, moveLineUp, moveLineDown, copyLineUp, copyLineDown, deleteLine, insertBlankLine, indentMore, indentLess, undo, redo,
  toggleComment, toggleBlockComment, startCompletion, openSearchPanel, gotoLine, cursorMatchingBracket, foldCode, unfoldCode, foldAll, unfoldAll,
]);
