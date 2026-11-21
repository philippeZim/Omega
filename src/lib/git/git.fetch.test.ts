import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { GIT_GUARD } from "../collab/gitArgs";

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

import { FETCH_INTERVAL, FETCH_TIMEOUT, fetchNow, git, pull, push, refresh } from "./git.svelte";

/** Fake repo: `fetch` moves origin/main ahead by one commit (behind++); `fetchFails` makes it fail. */
let fetches: number;
let behind: number;
let upstream: string | null;
let fetchFails: boolean;
/** When set, `git fetch` waits for this promise (a slow network). */
let fetchGate: Promise<void> | null;
let calls: string[][];
function fakeRepo() {
  mockIPC((cmd, payload) => {
    if (cmd === "git_status") return { repo: true, top: "/repo", branch: "main", upstream, ahead: 0, behind, changes: [] };
    if (cmd === "git") {
      const args = (payload as { args: string[] }).args;
      calls.push(args);
      if (args.includes("config")) return { code: 1, stdout: "", stderr: "" }; // no own core.sshCommand
      if (args.includes("fetch")) {
        fetches++;
        if (fetchGate) return fetchGate.then(() => ({ code: 0, stdout: "", stderr: "" }));
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
  fetchGate = null;
  calls = [];
  git.busy = "";
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

  test("background fetch never prompts: batch-mode ssh, no interactive credentials", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * FETCH_INTERVAL);
    await refresh();
    await settle();
    const f = calls.find((a) => a.includes("fetch"))!;
    expect(f).toEqual([...GIT_GUARD, "-c", "core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=15", "-c", "credential.interactive=never", "fetch", "--quiet"]);
    expect(f).toContain("core.hooksPath=/dev/null");
    vi.mocked(Date.now).mockRestore();
  });

  test("manual Fetch does nothing while a pull/push/commit is busy", async () => {
    git.busy = "git.busy.pull";
    await fetchNow();
    expect(fetches).toBe(0);
    expect(git.busy).toBe("git.busy.pull");
  });

  test("pull and push wait for a running background fetch; manual Fetch runs after it, with the host's hooks", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20 * FETCH_INTERVAL);
    let open!: () => void;
    fetchGate = new Promise((r) => (open = r));
    await refresh(); // starts the background fetch, which now hangs on the gate
    await settle();
    expect(fetches).toBe(1);
    const pulling = pull();
    const manual = (async () => {
      await settle();
      git.busy = "";
      return fetchNow();
    })();
    await settle();
    await settle();
    expect(calls.some((a) => a[0] === "pull")).toBe(false);
    open();
    await pulling;
    await manual;
    expect(calls.some((a) => a[0] === "pull")).toBe(true);
    expect(fetches).toBe(2); // the background one has its hooks off, so it can't stand in
    expect(calls.filter((a) => a.includes("fetch")).at(-1)).toEqual(["fetch", "--quiet"]);
    const pushing = push();
    await pushing;
    expect(calls.some((a) => a[0] === "push")).toBe(true);
    vi.mocked(Date.now).mockRestore();
  });

  test("a hanging fetch gives up after FETCH_TIMEOUT and frees pull", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * FETCH_INTERVAL);
    fetchGate = new Promise(() => {}); // never answers (unreachable host)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetches).toBe(1);
      const pulling = pull();
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT);
      await pulling;
      expect(calls.some((a) => a[0] === "pull")).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.mocked(Date.now).mockRestore();
    }
  });
});
