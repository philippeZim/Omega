import { expect, test } from "vitest";
import { isDocEntry, scrubPaths, textHash, wireDiagnostic, wireEdits, wireItem, wireMarkup } from "./lspProtocol";

const R = "/home/me/proj";
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

test.each([
  ["/home/me/proj/src/a.py:3 failed", "src/a.py:3 failed"],
  ["file:///home/me/proj/src/a%20b.py", "src/a b.py"],
  ["see file:///etc/passwd.", "see …/passwd."],
  ['"/home/other/.ssh/id_rsa"', '"…/id_rsa"'],
  ["in C:\\Users\\me\\secret\\x.py", "in …/x.py"],
  ["~/.config/app/token here", "…/token here"],
  ["https://docs.python.org/3/library/os.html stays", "https://docs.python.org/3/library/os.html stays"],
  ["a/b and 1/2 stay", "a/b and 1/2 stay"],
])("scrubPaths %s", (input, out) => {
  expect(scrubPaths(input, R)).toBe(out);
});

test("textHash tells texts apart", () => {
  expect(textHash("abc")).toBe(textHash("abc"));
  expect(textHash("abc")).not.toBe(textHash("abd"));
  expect(textHash("")).not.toBe(textHash(" "));
});

test("a diagnostic keeps only what's shown", () => {
  const d = wireDiagnostic({ range, severity: 1, message: `bad ${R}/a.py`, source: "x", relatedInformation: [{ location: { uri: `file://${R}/b.py` } }], data: { p: R } }, R);
  expect(d).toEqual({ range, severity: 1, message: "bad a.py", source: "x" });
  expect(wireDiagnostic({ message: "no range" }, R)).toBeNull();
  expect(wireDiagnostic({ range: { start: { line: -1, character: 0 }, end: range.end }, message: "x" }, R)).toBeNull();
});

test("long messages are cut", () => {
  expect(wireDiagnostic({ range, message: "x".repeat(5000) }, R)!.message.length).toBe(2000);
});

test("markup of every LSP shape is scrubbed", () => {
  expect(wireMarkup(`at ${R}/a.py`, R)).toBe("at a.py");
  expect(wireMarkup({ kind: "markdown", value: `at ${R}/a.py` }, R)).toEqual({ kind: "markdown", value: "at a.py" });
  expect(wireMarkup({ language: "py", value: `at ${R}/a.py` }, R)).toEqual({ language: "py", value: "at a.py" });
  expect(wireMarkup(["a", { language: "py", value: "b" }], R)).toEqual(["a", { language: "py", value: "b" }]);
  expect(wireMarkup({ nope: 1 }, R)).toBeUndefined();
});

test("edits writing the host path into the text are refused", () => {
  expect(wireEdits([{ range, newText: "ok" }], R)).toEqual([{ range, newText: "ok" }]);
  expect(wireEdits([{ range, newText: `import "${R}/x"` }], R)).toBeNull();
  expect(wireEdits([{ range: { start: range.start }, newText: "x" }], R)).toBeNull();
  expect(wireEdits("nope", R)).toBeNull();
});

test("completion items carry no server data, and none with the host path", () => {
  const w = wireItem({ label: "f", kind: 3, data: { file: R }, command: { command: "x" }, insertText: "f()", insertTextFormat: 2, textEdit: { insert: range, replace: range, newText: "f" } }, 7, R)!;
  expect(w).toEqual({ id: 7, label: "f", kind: 3, insertText: "f()", insertTextFormat: 2, textEdit: { range, newText: "f" } });
  expect(wireItem({ label: "f", textEdit: { range, newText: `${R}/x` } }, 0, R)).toBeNull();
  expect(wireItem({ label: "f", additionalTextEdits: [{ range, newText: `${R}/x` }] }, 0, R)).toBeNull();
  expect(wireItem({ nope: 1 }, 0, R)).toBeNull();
});

test("entries from the wire are checked", () => {
  const good = { rev: 1, hash: "a", len: 1, diagnostics: [{ range, message: "m" }], features: { triggers: ["."], hover: true, definition: true, format: true, codeActions: true, resolve: false } };
  expect(isDocEntry(good)).toBe(true);
  expect(isDocEntry({ ...good, rev: "1" })).toBe(false);
  expect(isDocEntry({ ...good, diagnostics: [{ message: "m" }] })).toBe(false);
  expect(isDocEntry({ ...good, features: {} })).toBe(false);
  expect(isDocEntry(null)).toBe(false);
});
