// DiffView: which HEAD version is compared, and what the header says.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { mockIPC } from "@tauri-apps/api/mocks";

const git = vi.hoisted(() => ({ top: "/r", changes: [] as { path: string; x: string; y: string; orig: string | null }[] }));
vi.mock("../lib/git/git.svelte", () => ({ git, refresh: vi.fn() }));
vi.mock("../lib/state.svelte", () => ({ app: { root: "/r", tabs: [] } }));
vi.mock("../lib/editor", () => ({ getText: () => "", applyChanges: vi.fn(), focus: vi.fn() }));
vi.mock("../lib/i18n/index.svelte", () => ({ t: (k: string, p?: object) => (p ? `${k} ${JSON.stringify(p)}` : k) }));

import DiffView from "./DiffView.svelte";
import { diffState } from "../lib/git/diff.svelte";

let cmp: ReturnType<typeof mount> | null = null;
let ipc: { cmd: string; args: Record<string, unknown> }[] = [];

async function open(file: string, head: Record<string, string>, disk: Record<string, string>) {
  ipc = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    ipc.push({ cmd, args: a });
    if (cmd === "git_head_file") return head[a.path as string] ?? null;
    if (cmd === "read_file") {
      if (a.path as string in disk) return disk[a.path as string];
      throw new Error("not found");
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
