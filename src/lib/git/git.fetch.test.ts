import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

const m = vi.hoisted(() => ({ toast: [] as [string, string | undefined][] }));

vi.mock("../state.svelte", () => ({
  app: { tabs: [], root: "/repo", treeVersion: 0 },
  setRoot: () => {},
  openFile: async () => {},
  save: async () => {},
  syncFromDisk: () => {},
}));
vi.mock("../ui.svelte", () => ({
  ui: { toast: (text: string, kind?: string) => m.toast.push([text, kind]), prompt: async () => null, confirm: async () => true },
}));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true }));
vi.mock("../native", () => ({ openDialog: async () => null }));
vi.mock("../i18n/index.svelte", () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k) }));

import { FETCH_INTERVAL, fetchNow, refresh } from "./git.svelte";

/** Fake repo: `fetch` moves origin/main ahead by one commit (behind++); `fetchFails` makes it fail. */
let fetches: number;
let behind: number;
let upstream: string | null;
let fetchFails: boolean;
function fakeRepo() {
  mockIPC((cmd, payload) => {
    if (cmd === "git_status") return { repo: true, top: "/repo", branch: "main", upstream, ahead: 0, behind, changes: [] };
    if (cmd === "git") {
      const args = (payload as { args: string[] }).args;
      if (args[0] === "fetch") {
        fetches++;
        if (fetchFails) return { code: 128, stdout: "", stderr: "fatal: 'origin' does not appear to be a git repository" };
        behind++;
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return null;
  });
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  m.toast = [];
  fetches = 0;
  behind = 0;
  upstream = "origin/main";
  fetchFails = false;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  fakeRepo();
});

describe("fetch (#75)", () => {
  test("refresh fetches in the background, at most every FETCH_INTERVAL, and the behind count follows", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000_000);
    await refresh();
    await settle();
    expect(fetches).toBe(1);
    await refresh();
    await settle();
    expect(fetches).toBe(1); // too soon
    now.mockReturnValue(1_000_000_000 + FETCH_INTERVAL);
    await refresh();
    await settle();
    expect(fetches).toBe(2);
    const { git } = await import("./git.svelte");
    expect(git.behind).toBe(2);
    now.mockRestore();
  });

  test("no automatic fetch without an upstream or without focus; failures stay silent", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000);
    upstream = null;
    await refresh();
    await settle();
    expect(fetches).toBe(0);
    upstream = "origin/main";
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await refresh();
    await settle();
    expect(fetches).toBe(0);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    fetchFails = true;
    await refresh();
    await settle();
    expect(fetches).toBe(1);
    expect(m.toast).toEqual([]);
    now.mockRestore();
  });

  test("manual Fetch reports new commits, or the error", async () => {
    await fetchNow();
    expect(m.toast.at(-1)?.[0]).toContain("git.fetchedOne");
    fetchFails = true;
    await fetchNow();
    expect(m.toast.at(-1)).toEqual([expect.stringContaining("does not appear to be a git repository"), "error"]);
  });
});
