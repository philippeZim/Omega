import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

// ---------------------------------------------------------------- heavy imports, stubbed

const m = vi.hoisted(() => ({
  toast: [] as [string, string | undefined][],
  prompt: null as string | null,
}));

vi.mock("../state.svelte", () => ({
  app: { tabs: [], root: "/repo", treeVersion: 0 },
  setRoot: () => {},
  openFile: async () => {},
  save: async () => {},
  syncFromDisk: () => {},
}));
vi.mock("../ui.svelte", () => ({
  ui: {
    toast: (text: string, kind?: string) => m.toast.push([text, kind]),
    prompt: async () => m.prompt,
    confirm: async () => true,
  },
}));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true }));
vi.mock("../native", () => ({ openDialog: async () => null }));
vi.mock("../i18n/index.svelte", () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k) }));

import { git, newBranch } from "./git.svelte";

/** Fake git: `handler` gets the git argv and returns {code, stdout, stderr} (default: success). */
function fakeGit(handler: (args: string[]) => Partial<{ code: number; stdout: string; stderr: string }> | undefined) {
  mockIPC((cmd, payload) => {
    if (cmd === "git") return { code: 0, stdout: "", stderr: "", ...handler((payload as { args: string[] }).args) };
    if (cmd === "git_status") return { repo: true, top: "/repo", branch: git.branch, upstream: null, ahead: 0, behind: 0, changes: [] };
    return null;
  });
}

beforeEach(() => {
  m.toast = [];
  m.prompt = null;
  git.top = "/repo";
});

describe("git error toasts (#71)", () => {
  test("a failed command toasts git's fatal line, not the trailing hints", async () => {
    const stderr = [
      "fatal: 'feature/bad-name..x' is not a valid branch name",
      "hint: See 'git help check-ref-format'",
      'hint: Disable this message with "git config set advice.refSyntax false"',
    ].join("\n");
    fakeGit((a) => (a[0] === "switch" ? { code: 128, stderr } : undefined));
    m.prompt = "feature/bad name..x";
    await newBranch();
    const err = m.toast.find(([, kind]) => kind === "error")?.[0];
    expect(err).toContain("'feature/bad-name..x' is not a valid branch name");
    expect(err).not.toContain("hint");
  });
});
