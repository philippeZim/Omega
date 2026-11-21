import { describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

vi.mock("../state.svelte", () => ({
  app: { tabs: [], root: "/repo", treeVersion: 0 },
  setRoot: () => {},
  openFile: async () => {},
  save: async () => {},
  syncFromDisk: () => {},
}));
vi.mock("../ui.svelte", () => ({ ui: { toast: () => {}, prompt: async () => null, confirm: async () => true } }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true }));
vi.mock("../native", () => ({ openDialog: async () => null }));
vi.mock("../i18n/index.svelte", () => ({ t: (k: string) => k }));

import { git, refresh } from "./git.svelte";

describe("headVersion (#69)", () => {
  test("bumps when HEAD moves on the same branch (commit made outside Omega)", async () => {
    let sha = "aaaa";
    mockIPC((cmd, payload) => {
      if (cmd === "git_status") return { repo: true, top: "/repo", branch: "main", upstream: null, ahead: 0, behind: 0, changes: [] };
      if (cmd === "git") {
        const args = (payload as { args: string[] }).args;
        if (args.includes("rev-parse")) return { code: 0, stdout: sha + "\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
      return null;
    });
    await refresh();
    const v = git.headVersion;
    await refresh();
    expect(git.headVersion).toBe(v); // nothing moved: gutters keep their HEAD contents
    sha = "bbbb";
    await refresh();
    expect(git.headVersion).toBe(v + 1);
  });
});
