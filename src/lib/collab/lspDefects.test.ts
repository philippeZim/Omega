// Regressions from the review of guest language features, against the wire helpers.
import { expect, test } from "vitest";
import { hostPathIn, hostPaths, isKnownLibrary, scrubPaths, wireDiagnostic, wireEdits, wireItem } from "./lspProtocol";

const R = "/home/eron/proj";
const P = hostPaths(R, ["/home/eron", "/tmp", "/home/eron/.local/share/omega/tools"]);
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

test.each([
  ["→ /home/eron/.ssh/id_rsa", "→ …/id_rsa"],
  ["a|/home/eron/x/y.py", "a|…/y.py"],
  ["*/home/eron/x/y.py*", "*…/y.py*"],
  ["{/home/eron/x/y.py}", "{…/y.py}"],
  [">/etc/ssl/key.pem", ">…/key.pem"],
  ["@/home/other/a/b.py", "@…/b.py"],
  ["!/home/other/a/b.py", "!…/b.py"],
  ["File:///home/eron/x/y.py", "…/y.py"],
  ["FILE:///etc/passwd", "…/passwd"],
  ["\\\\server\\share\\eron\\a.txt", "…/a.txt"],
  ["%2Fhome%2Feron%2Fsecret%2Fa.py", "…/a.py"],
  ["C:\\Users\\Eron Z\\proj\\a.py failed", "…/a.py failed"],
  ["c:/users/eron/a.py", "…/a.py"],
  ["/home/Other User/secret/a.py", "…/a.py"],
  ["/home/eron", "…"],
  ["see /home/other", "see …"],
  ["/home/eron/proj/src/a b.py", "src/a b.py"],
  ["%2Fhome%2Feron%2Fproj%2Fsrc%2Fa.py", "src%2Fa.py"],
  ["https://docs.python.org/3/library/os.html", "https://docs.python.org/3/library/os.html"],
  ["a/b and 1/2", "a/b and 1/2"],
])("scrubPaths %s", (input, out) => {
  expect(scrubPaths(input, P)).toBe(out);
});

test("no scrubbed text keeps the user name", () => {
  for (const s of ["/home/eron", "/home/eron/", "file:///home/eron", "%2Fhome%2Feron", "C:\\Users\\eron", "/Users/eron/"]) expect(scrubPaths(s, hostPaths("/w", ["/home/eron"]))).not.toMatch(/eron/i);
});

test("a path-like completion inserts unchanged and shows scrubbed", () => {
  const w = wireItem({ label: "/api/users/list" }, 0, P)!;
  expect(w.label).toBe("…/list");
  expect(w.insertText).toBe("/api/users/list");
  expect(w.filterText).toBe("/api/users/list");
});

test("insertText of a path-like item is not altered", () => {
  expect(wireItem({ label: "x", insertText: "/api/users/list" }, 0, P)!.insertText).toBe("/api/users/list");
});

test.each([
  ["label", { label: "/home/eron/secret.py" }],
  ["insertText", { label: "x", insertText: "/home/eron/secret" }],
  ["encoded", { label: "x", insertText: "%2Fhome%2Feron%2Fsecret" }],
  ["file uri", { label: "x", insertText: "file:///home/eron/secret" }],
  ["filterText", { label: "x", filterText: "/home/eron/secret" }],
  ["sortText", { label: "x", sortText: "/tmp/secret" }],
  ["textEdit", { label: "x", textEdit: { range, newText: "/home/eron/proj/x" } }],
  ["additional", { label: "x", additionalTextEdits: [{ range, newText: "import '/tmp/x'" }] }],
])("an item whose %s holds a host path is dropped", (_n, item) => {
  expect(wireItem(item, 0, P)).toBeNull();
});

test("a host path already in the document is not a new leak", () => {
  const doc = 'open("/tmp/data.txt")\n';
  expect(wireEdits([{ range, newText: 'open("/tmp/data.txt")' }], P, doc)).not.toBeNull();
  expect(wireEdits([{ range, newText: 'open("/tmp/other.txt")' }], P, doc)).toBeNull();
});

test("hostPathIn tells real host paths from look-alikes", () => {
  expect(hostPathIn("/api/users/list", P)).toBe(false);
  expect(hostPathIn("/tmpfile/x", P)).toBe(false);
  expect(hostPathIn("x/home/eron/y", P)).toBe(false);
  expect(hostPathIn("/tmp/x", P)).toBe(true);
  expect(hostPathIn("C:\\x", hostPaths("C:/Work/p"))).toBe(false);
  expect(hostPathIn("c:\\work\\P\\a.py", hostPaths("C:/Work/p"))).toBe(true);
});

test.each([
  "/usr/lib/python3.13/os.py",
  "/home/eron/proj/.venv/lib/python3.13/site-packages/x/y.py",
  "/w/node_modules/typescript/lib/lib.dom.d.ts",
  "/home/eron/.cargo/registry/src/index/serde-1/lib.rs",
  "/home/eron/.rustup/toolchains/stable/lib/rustlib/src/rust/library/core/src/lib.rs",
  "/usr/include/stdio.h",
  "/home/eron/.local/share/omega/tools/python/node_modules/basedpyright/dist/typeshed-fallback/stdlib/builtins.pyi",
])("%s is a library location", (p) => {
  expect(isKnownLibrary(p)).toBe(true);
});

test.each(["/home/eron/notes/secret.py", "/etc/passwd", "/w/node_modules/.git/config", "/home/eron/.ssh/node_modules/key", "/srv/private/a.py"])("%s is not", (p) => {
  expect(isKnownLibrary(p)).toBe(false);
});

test("a very long message is scrubbed in bounded time", () => {
  const t0 = performance.now();
  scrubPaths("/a b ".repeat(50_000), P);
  expect(performance.now() - t0).toBeLessThan(1000);
});

test("diagnostic messages use the same rules", () => {
  expect(wireDiagnostic({ range, message: "→ /home/eron/.ssh/id_rsa" }, P)!.message).toBe("→ …/id_rsa");
});
