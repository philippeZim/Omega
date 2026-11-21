import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { deleteCharBackward, deleteCharForward, history, insertNewlineAndIndent, undo, redo } from "@codemirror/commands";
import { ySyncAnnotation } from "y-codemirror.next";
import { debugExtension } from "./editorExt";
import { dbg, SHARED_BP } from "./store.svelte";

const PATH = "/w/a.py";
let view: EditorView;

function open(doc: string, line: number, path = PATH) {
  dbg.breakpoints[path] = [{ line }];
  view = new EditorView({ state: EditorState.create({ doc, extensions: [history(), debugExtension(path)] }), parent: document.body });
}

/** The lines the editor reports to the store after an edit. */
function lines(path = PATH) {
  vi.advanceTimersByTime(500);
  return (dbg.breakpoints[path] ?? []).map((b) => b.line);
}

function enterAt(pos: number) {
  view.dispatch({ selection: { anchor: pos } });
  insertNewlineAndIndent(view);
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  view.destroy();
  for (const key of Object.keys(dbg.breakpoints)) delete dbg.breakpoints[key];
  vi.useRealTimers();
});

describe("breakpoints follow the code", () => {
  test("Enter at column 1 moves the marker with the code", () => {
    open("one\ntwo\nthree", 2);
    enterAt(4);
    expect(view.state.doc.line(3).text).toBe("two");
    expect(lines()).toEqual([3]);
  });

  test("Enter in the middle or at the end of the line keeps it", () => {
    open("one\ntwo\nthree", 2);
    enterAt(5);
    expect(lines()).toEqual([2]);
    view.destroy();
    open("one\ntwo\nthree", 2);
    enterAt(7);
    expect(lines()).toEqual([2]);
  });

  test("Enter on an empty breakpoint line keeps it", () => {
    open("one\n\nthree", 2);
    enterAt(4);
    expect(lines()).toEqual([2]);
  });

  test("a line break with indentation still lands on the code's line", () => {
    open("one\ntwo\nthree", 2);
    view.dispatch({ changes: { from: 4, insert: "\n    " } });
    expect(lines()).toEqual([3]);
  });

  test("undo and redo bring it back and forth", () => {
    open("one\ntwo\nthree", 2);
    enterAt(4);
    expect(lines()).toEqual([3]);
    undo(view);
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree");
    expect(lines()).toEqual([2]);
    redo(view);
    expect(lines()).toEqual([3]);
  });

  test("undo of an indented line break keeps it", () => {
    open("one\ntwo\nthree", 2);
    view.dispatch({ changes: { from: 4, insert: "\n    " } });
    expect(lines()).toEqual([3]);
    view.dispatch({ changes: { from: 4, to: 9 } });
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree");
    expect(lines()).toEqual([2]);
  });

  test("typing at column 1 keeps it on its line", () => {
    open("one\ntwo\nthree", 2);
    view.dispatch({ changes: { from: 4, insert: "x" } });
    expect(lines()).toEqual([2]);
  });

  test("joining a breakpoint's line into the previous one removes it, as it always did", () => {
    for (const [pos, command] of [[4, deleteCharBackward], [3, deleteCharForward]] as const) {
      open("one\ntwo\nthree", 2);
      view.dispatch({ selection: { anchor: pos } });
      command(view);
      expect(view.state.doc.line(1).text).toBe("onetwo");
      expect(lines()).toEqual([]);
      view.destroy();
    }
    open("one", 1);
  });

  test("undo of a deleted line puts the marker back on that line", () => {
    open("one\ntwo\nthree", 2);
    view.dispatch({ changes: { from: 4, to: 8 } });
    expect(lines()).toEqual([2]);
    undo(view);
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree");
    expect(lines()).toEqual([2]);
  });

  test("a conditional marker wins over a plain one on the same line", () => {
    dbg.breakpoints[PATH] = [{ line: 2 }, { line: 3, condition: "x > 1" }];
    view = new EditorView({ state: EditorState.create({ doc: "one\n\nthree", extensions: [history(), debugExtension(PATH)] }), parent: document.body });
    view.dispatch({ changes: { from: 4, to: 5 } });
    vi.advanceTimersByTime(500);
    expect(dbg.breakpoints[PATH].map((b) => [b.line, b.condition])).toEqual([[2, "x > 1"]]);
  });

  test("two markers that end up on one line stay one", () => {
    dbg.breakpoints[PATH] = [{ line: 2 }, { line: 3 }];
    view = new EditorView({ state: EditorState.create({ doc: "one\n\nthree", extensions: [history(), debugExtension(PATH)] }), parent: document.body });
    view.dispatch({ changes: { from: 4, to: 5 } });
    expect(lines()).toEqual([2]);
  });

  test("a shared file moves it for a remote Enter too, without reporting that edit", () => {
    const path = SHARED_BP + "a.py";
    open("one\ntwo\nthree", 2, path);
    view.dispatch({ changes: { from: 4, insert: "\n" }, annotations: ySyncAnnotation.of(null as never) });
    expect(lines(path)).toEqual([2]);
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(lines(path)).toEqual([3]);
  });
});
