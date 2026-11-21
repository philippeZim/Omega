import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

// ---------------------------------------------------------------- heavy imports, stubbed

const m = vi.hoisted(() => ({
  toast: [] as [string, string | undefined][],
  prompt: null as string | null,
}));

vi.mock("../state.svelte", () => ({
  app: { tabs: [], root: "/repo", treeVersion: 0 },
  setRoot: vi.fn(),
  openFile: vi.fn(async () => {}),
  save: async () => {},
  syncFromDisk: () => {},
}));
vi.mock("../ui.svelte", () => ({
  ui: {
    toast: (text: string, kind?: string) => m.toast.push([text, kind]),
    prompt: async () => m.prompt,
    confirm: async () => true,
    choose: async () => "private",
  },
}));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true }));
vi.mock("../native", () => ({ openDialog: async () => null }));
vi.mock("../i18n/index.svelte", () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k) }));

import { cloneInto, git, newBranch, publishGitHub } from "./git.svelte";

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

  test("clone failure returns the fatal line, not the trailing advice (#93)", async () => {
    const stderr = [
      "Cloning into '/home/me/repo'...",
      "fatal: repository 'https://example.com/nope.git/' not found",
    ].join("\n");
    fakeGit((a) => (a[0] === "clone" ? { code: 128, stderr } : undefined));
    expect(await cloneInto("https://example.com/nope.git", "/home/me/repo")).toBe("repository 'https://example.com/nope.git/' not found");
    const ssh = "Cloning into 'repo'...\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";
    fakeGit((a) => (a[0] === "clone" ? { code: 128, stderr: ssh } : undefined));
    expect(await cloneInto("git@github.com:me/repo.git", "/home/me/repo")).toBe("Could not read from remote repository.");
  });

  test("publish failure toasts gh's error, not its last hint line (#93)", async () => {
    m.prompt = "repo";
    mockIPC((cmd) => {
      if (cmd === "git") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git_status") return { repo: true, top: "/repo", branch: "main", upstream: null, ahead: 0, behind: 0, changes: [] };
      if (cmd === "run_capture")
        return {
          code: 1,
          stdout: "",
          stderr: "remote: error: GH013: Repository rule violations found for refs/heads/main.\nerror: failed to push some refs to 'github.com:me/repo.git'\nhint: see the docs",
        };
      return null;
    });
    git.repo = true;
    await publishGitHub();
    const err = m.toast.find(([, kind]) => kind === "error")?.[0];
    expect(err).toContain("GH013: Repository rule violations found");
    expect(err).not.toContain("hint");
  });
});

test("Clone doesn't open during a guest session", async () => {
  const { guestGuard } = await import("../collab/guard");
  const { cloneRepo, cloneTabRequested } = await import("./git.svelte");
  cloneTabRequested.value = false;
  guestGuard.status = () => "connected";
  await cloneRepo();
  guestGuard.status = () => "none";
  expect(cloneTabRequested.value).toBe(false);
});

test("a clone that finishes after becoming a guest stays out of the session", async () => {
  const { guestGuard } = await import("../collab/guard");
  const { setRoot, openFile } = await import("../state.svelte");
  vi.mocked(setRoot).mockClear();
  vi.mocked(openFile).mockClear();
  mockIPC((cmd) => {
    if (cmd === "git") {
      guestGuard.status = () => "connected";
      return { code: 0, stdout: "", stderr: "" };
    }
    return cmd === "path_exists" ? true : null;
  });
  const result = await cloneInto("https://example.com/r.git", "/home/me/r");
  guestGuard.status = () => "none";
  expect(result).toBeNull();
  expect(setRoot).not.toHaveBeenCalled();
  expect(openFile).not.toHaveBeenCalled();
  expect(m.toast.map(([text]) => text.split(" ")[0])).toEqual(["ai.collab.createdNotOpened"]);
});
