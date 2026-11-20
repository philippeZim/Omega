import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

// ---------------------------------------------------------------- heavy imports, stubbed

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

import { abortOperation, branches, commit, git, pull, push, refresh } from "./git.svelte";

// ---------------------------------------------------------------- scripted fake repository

/** State of the fake repo; git commands change it the way real git would. */
let repo: { branch: string; operation: "rebase" | "merge" | null; changes: { path: string; x: string; y: string; orig: null }[]; files: Record<string, string> };
let calls: string[][];

function fakeRepo() {
  mockIPC((cmd, payload) => {
    const p = payload as { args: string[]; path: string };
    if (cmd === "git_status")
      return { repo: true, top: "/repo", branch: repo.branch, upstream: repo.operation ? null : "origin/main", ahead: 0, behind: 0, changes: repo.changes, operation: repo.operation };
    if (cmd === "read_file") return repo.files[p.path] ?? "";
    if (cmd !== "git") return null;
    const a = p.args;
    calls.push(a);
    const ok = { code: 0, stdout: "", stderr: "" };
    if (a[0] === "pull") {
      // pull.rebase=true and the remote changed c.txt too: stops at a conflict, HEAD detached.
      Object.assign(repo, { branch: "main", operation: "rebase", changes: [{ path: "c.txt", x: "U", y: "U", orig: null }] });
      return { code: 1, stdout: "", stderr: "Recorded preimage for 'c.txt'\nerror: could not apply afda55c... local c\nhint: Resolve all conflicts manually" };
    }
    if (a[0] === "branch") return { ...ok, stdout: "(no branch, rebasing main)\nmain\norigin/main\n" };
    if (a[0] === "diff") return { code: 1, stdout: "", stderr: "" }; // something staged
    if (a[0] === "rebase" && a[1] === "--continue") {
      Object.assign(repo, { operation: null, changes: [] });
      return ok;
    }
    if (a[0] === "rebase" && a[1] === "--abort") {
      Object.assign(repo, { operation: null, changes: [] });
      return ok;
    }
    return ok;
  });
}

beforeEach(async () => {
  m.toast = [];
  calls = [];
  repo = { branch: "main", operation: null, changes: [], files: {} };
  fakeRepo();
  git.message = "";
  git.excluded = [];
  await refresh();
});

const lastToast = () => m.toast.at(-1);

describe("pull stopped at a rebase conflict (#67)", () => {
  test("toast names the conflicted file and the next steps, state shows the rebase", async () => {
    await pull();
    expect(git.operation).toBe("rebase");
    expect(git.branch).toBe("main");
    expect(lastToast()).toEqual([expect.stringContaining("git.pullConflict"), "error"]);
    expect(lastToast()?.[0]).toContain("c.txt");
  });

  test("push refuses while the rebase runs, and on a detached HEAD", async () => {
    await pull();
    calls = [];
    await push();
    expect(calls.some((a) => a[0] === "push")).toBe(false);
    expect(lastToast()).toEqual(["git.pushDuringRebase", "error"]);

    Object.assign(repo, { branch: "HEAD (no branch)", operation: null, changes: [] });
    await refresh();
    await push();
    expect(calls.some((a) => a[0] === "push")).toBe(false);
    expect(lastToast()).toEqual(["git.pushDetached", "error"]);
  });

  test("Commit stages the resolved file and continues the rebase (no reset, no detached commit)", async () => {
    await pull();
    repo.files["/repo/c.txt"] = "resolved\n";
    calls = [];
    await commit(false);
    expect(calls).toContainEqual(["add", "-A", "--", "c.txt"]);
    expect(calls).toContainEqual(["rebase", "--continue"]);
    expect(calls.some((a) => a[0] === "reset")).toBe(false);
    expect(calls.some((a) => a[0] === "commit")).toBe(false); // no message typed: keep the replayed one
    expect(git.operation).toBe("");
    expect(lastToast()).toEqual(["git.rebaseDone", undefined]);
  });

  test("Commit refuses while conflict markers are left", async () => {
    await pull();
    repo.files["/repo/c.txt"] = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> afda55c (local c)\n";
    calls = [];
    await commit(false);
    expect(calls.some((a) => a[0] === "add" || a[0] === "rebase")).toBe(false);
    expect(lastToast()?.[0]).toContain("git.conflictMarkers");
    expect(git.operation).toBe("rebase");
  });

  test("Abort runs git rebase --abort", async () => {
    await pull();
    calls = [];
    await abortOperation();
    expect(calls).toContainEqual(["rebase", "--abort"]);
    expect(git.operation).toBe("");
    expect(lastToast()).toEqual(["git.rebaseAborted", undefined]);
  });

  test("the branch list leaves out the detached '(no branch, rebasing main)' entry", async () => {
    expect(await branches()).toEqual({ local: ["main"], remote: [] });
  });
});
