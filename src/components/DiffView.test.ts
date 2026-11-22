// DiffView: which HEAD version is compared, and what the header says.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { mockIPC } from "@tauri-apps/api/mocks";
import { EditorView } from "@codemirror/view";
import { getChunks } from "@codemirror/merge";

const git = vi.hoisted(() => ({ top: "/r", changes: [] as { path: string; x: string; y: string; orig: string | null }[] }));
vi.mock("../lib/git/git.svelte", () => ({ git, refresh: vi.fn() }));
vi.mock("../lib/state.svelte", () => ({ app: { root: "/r", tabs: [] } }));
vi.mock("../lib/editor", () => ({ getText: () => "", applyChanges: vi.fn(), focus: vi.fn() }));
vi.mock("../lib/i18n/index.svelte", () => ({ t: (k: string, p?: object) => (p ? `${k} ${JSON.stringify(p)}` : k) }));

import DiffView from "./DiffView.svelte";
import { diffState } from "../lib/git/diff.svelte";

let cmp: ReturnType<typeof mount> | null = null;
let ipc: { cmd: string; args: Record<string, unknown> }[] = [];

const TOO_LARGE = "<too large>";

/** `disk`: path → text, or null for a file that exists but is not UTF-8 (read_file rejects). */
async function open(file: string, head: Record<string, string>, disk: Record<string, string | null>) {
  ipc = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const p = a.path as string;
    ipc.push({ cmd, args: a });
    if (cmd === "git_head_file") {
      if (head[p] === TOO_LARGE) throw "fs:too_large";
      return head[p] ?? null;
    }
    if (cmd === "file_info") return { size: 9e9, too_large: disk[p] === TOO_LARGE };
    if (cmd === "path_exists") return p in disk;
    if (cmd === "read_file") {
      if (disk[p] === TOO_LARGE) throw "fs:too_large";
      if (typeof disk[p] === "string") return disk[p];
      throw new Error(p in disk ? "not UTF-8" : "not found");
    }
    return null;
  });
  diffState.file = file;
  cmp = mount(DiffView, { target: document.body });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

const side = (s: "a" | "b") => document.querySelector(`.cm-merge-${s} .cm-content`)?.textContent ?? null;
const info = () => document.querySelector("header .info")?.textContent ?? null;

beforeEach(() => {
  git.changes = [];
});
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = "";
});

describe("renamed file (#70)", () => {
  test("compares against HEAD of the original path and names it", async () => {
    git.changes = [{ path: "b-renamed.txt", x: "R", y: " ", orig: "b.txt" }];
    await open("/r/b-renamed.txt", { "/r/b.txt": "hello\n" }, { "/r/b-renamed.txt": "hello\n" });
    expect(ipc.find((c) => c.cmd === "git_head_file")?.args.path).toBe("/r/b.txt");
    expect(side("a")).toBe("hello");
    expect(info()).toContain("git.diff.renamedFrom");
    expect(info()).toContain("b.txt");
  });

  test("an ordinary new file still says so", async () => {
    git.changes = [{ path: "n.txt", x: "?", y: "?", orig: null }];
    await open("/r/n.txt", {}, { "/r/n.txt": "x\n" });
    expect(info()).toBe("git.diff.newFile");
  });
});

describe("large diff (#74)", () => {
  test("scattered changes in a 5000-line file become many small chunks, not one block", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const head = lines.join("\n") + "\n";
    const cur = lines.map((l, i) => ((i + 1) % 7 === 0 ? l + " CHANGED" : l)).join("\n") + "\n";
    await open("/r/big.txt", { "/r/big.txt": head }, { "/r/big.txt": cur });
    const b = EditorView.findFromDOM(document.querySelector(".cm-merge-b") as HTMLElement)!;
    expect(getChunks(b.state)!.chunks.length).toBe(714);
  });
});

describe("binary file (#66)", () => {
  const bytes = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");

  test("non-UTF-8 working copy: binary notice, no editors, no revert arrows, nothing written", async () => {
    await open("/r/bin.dat", { "/r/bin.dat": bytes }, { "/r/bin.dat": null });
    expect(info()).toBe("git.diff.binary");
    expect(document.querySelector(".cm-mergeView")).toBeNull();
    expect(document.querySelector(".cm-merge-revert")).toBeNull();
    expect(ipc.some((c) => c.cmd === "write_file")).toBe(false);
  });

  test("NUL bytes in HEAD count as binary", async () => {
    await open("/r/bin.dat", { "/r/bin.dat": "a\0b" }, { "/r/bin.dat": "a\0c" });
    expect(info()).toBe("git.diff.binary");
    expect(document.querySelector(".cm-mergeView")).toBeNull();
  });

  test("a file that is really gone still says deleted", async () => {
    await open("/r/gone.txt", { "/r/gone.txt": "x\n" }, {});
    expect(info()).toBe("git.diff.deleted");
    expect(document.querySelector(".cm-mergeView")).not.toBeNull();
  });
});

describe("too large files (#174)", () => {
  test.each([
    ["on disk", { "/r/big.log": "x\n" }, { "/r/big.log": TOO_LARGE }],
    ["in HEAD", { "/r/big.log": TOO_LARGE }, { "/r/big.log": "x\n" }],
  ])("%s: no editor that could write the file", async (_where, head, disk) => {
    await open("/r/big.log", head, disk);
    expect(document.querySelector(".cm-mergeView")).toBeNull();
    expect(document.querySelector(".binary")?.textContent).toBe("git.diff.tooLargeLocal");
    expect(ipc.some((c) => c.cmd === "write_file")).toBe(false);
  });
});

test("a large file open in a tab gets no text diff (#174)", async () => {
  const { app } = await import("../lib/state.svelte");
  (app.tabs as unknown[]).push({ id: "l", path: "/r/mid.log", large: true });
  await open("/r/mid.log", { "/r/mid.log": "x\n" }, { "/r/mid.log": "y\n" });
  (app.tabs as unknown[]).length = 0;
  expect(document.querySelector(".cm-mergeView")).toBeNull();
  expect(document.querySelector(".binary")?.textContent).toBe("git.diff.tooLargeLocal");
});

