// Code Together Git, host side: the real RPC layer and a real git repository, with a fake transport.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error No Node types in this project; the test runs under Node.
import { spawnSync } from "node:child_process";
// @ts-expect-error No Node types in this project; the test runs under Node.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// @ts-expect-error No Node types in this project; the test runs under Node.
import { tmpdir } from "node:os";
// @ts-expect-error No Node types in this project; the test runs under Node.
import { dirname, join, resolve, sep } from "node:path";
import { fakeUi } from "../../test/fakes";
import { GIT_GUARD, gitArgv, gitFailCode, scopeChanges, validBranch, validMessage, validPath, validPaths } from "./gitArgs";

type Msg = Record<string, any>;
const h = vi.hoisted(() => ({
  handlers: [] as ((peer: string, msg: Record<string, any>) => unknown)[],
  endHooks: [] as (() => unknown)[],
  sent: [] as { peer: string; msg: Record<string, any> }[],
  collab: { role: "host" as "host" | "guest" | null, status: "connected", hostPeer: null as string | null, participants: [] as any[], myCaps: [] as string[] },
  app: { root: "" as string | null, tabs: [] as any[], treeVersion: 0 },
  order: [] as string[],
  shared: { flush: true, unsaved: false, kept: [] as string[] },
  argv: [] as string[][],
  tabText: new Map<string, string>(),
}));

vi.mock("./collab.svelte", () => ({
  collab: h.collab,
  send: async (peer: string, msg: Msg) => void h.sent.push({ peer, msg: JSON.parse(JSON.stringify(msg)) }),
  onCollabMessage: (fn: (peer: string, msg: Msg) => unknown) => void h.handlers.push(fn),
  sessionEndHooks: h.endHooks,
}));
const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true }));
vi.mock("../native", () => ({ openDialog: async () => null }));
vi.mock("../fsWatch.svelte", () => ({ onFilesChanged: () => {} }));
vi.mock("../editor", () => ({ getText: (id: string) => h.tabText.get(id) ?? "" }));
vi.mock("../git/gutter", () => ({ setRemoteHead: () => {} }));
vi.mock("../git/blame.svelte", () => ({ setRemoteBlame: () => {} }));
vi.mock("../state.svelte", () => ({
  app: h.app,
  setRoot: () => {},
  openFile: async () => {},
  pathMoved: () => h.order.push("pathMoved"),
  save: async (id: string) => {
    h.order.push("save");
    const tab = h.app.tabs.find((x) => x.id === id);
    writeFileSync(tab.path, h.tabText.get(id) ?? "");
    tab.dirty = false;
  },
  syncFromDisk: async () => void h.order.push("syncFromDisk"),
}));
vi.mock("../api", async () => {
  // @ts-expect-error No Node types in this project; the test runs under Node.
  const fs = await import("node:fs");
  return {
    joinPath: (a: string, b: string) => `${a}/${b}`,
    basename: (p: string) => p.split("/").pop() ?? p,
    fsApi: {
      readFile: async (p: string) => fs.readFileSync(p, "utf8"),
      exists: async (p: string) => fs.existsSync(p),
      remove: async (p: string) => fs.rmSync(p),
    },
  };
});
vi.mock("./share.svelte", () => ({
  guestScope: () => {
    const root = h.app.root;
    if (!root) return null;
    return {
      root,
      live: () => h.app.root === root,
      // Like collab_path_inside: symlinks are resolved and must stay inside.
      check: async (rel: string) => {
        let p = resolve(root, rel);
        while (!existsSync(p) && p !== dirname(p)) p = dirname(p);
        const real = realpathSync(p);
        return real === realpathSync(root) || real.startsWith(realpathSync(root) + sep);
      },
      abs: (rel: string) => (rel ? `${root}/${rel}` : root),
      rel: (abs: string) => (abs === root ? "" : abs.startsWith(root + "/") && !abs.slice(root.length + 1).split("/").includes(".git") ? abs.slice(root.length + 1) : null),
    };
  },
  flushSharedDocs: async () => (h.order.push("flush"), h.shared.flush),
  sharedDocUnsaved: () => h.shared.unsaved,
  reloadSharedDocs: async () => (h.order.push("reload"), h.shared.kept),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, a: any) => {
    if (cmd === "git") {
      h.argv.push(a.args);
      if (a.args.includes("switch")) h.order.push("git switch");
      if (a.args.includes("restore")) h.order.push("git restore");
      return gitRun(a.root, a.args);
    }
    if (cmd === "git_status") return statusOf(a.root);
    if (cmd === "collab_tree_has_git") return false;
    if (cmd === "git_blame") return { commits: [], lines: [], noTextconv: a.noTextconv };
    throw new Error(`unexpected ${cmd}`);
  },
}));

const ID = ["-c", "user.name=Host Person", "-c", "user.email=host@example.invalid", "-c", "commit.gpgSign=false", "-c", "protocol.file.allow=always"];
function gitRun(root: string, args: string[]) {
  const r = spawnSync("git", [...ID, ...args], { cwd: root, encoding: "utf8", env: { ...(globalThis as any).process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" } });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
function statusOf(root: string) {
  const top = gitRun(root, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { repo: false, top: "", branch: "", upstream: null, ahead: 0, behind: 0, changes: [] };
  const out = gitRun(top.stdout.trim(), ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]).stdout.split("\0").filter(Boolean);
  let branch = "";
  let upstream: string | null = null;
  const changes: any[] = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    if (p.startsWith("## ")) {
      const head = p.slice(3).replace("No commits yet on ", "").split(" [")[0];
      [branch, upstream = null] = head.split("...") as [string, string?] as any;
      continue;
    }
    const x = p[0];
    changes.push({ path: p.slice(3), x, y: p[1], orig: x === "R" ? out[++i] : null });
  }
  return { repo: true, top: top.stdout.trim(), branch, upstream, ahead: 0, behind: 0, changes, operation: null };
}

const { RPC_LIMITS } = await import("./rpc.svelte");
await import("./gitRemote.svelte");
const { git } = await import("../git/git.svelte");

let dir = "";
let repo = "";
let nextId = 1;
const sh = (...args: string[]) => {
  const r = gitRun(repo, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

async function rpc(method: string, params: unknown, caps: string[] = ["git", "git-remote"]) {
  h.collab.participants = [{ peer: "p1", role: "guest", name: "Guest Ann", caps }];
  const id = nextId++;
  await Promise.all(h.handlers.map((fn) => fn("p1", { t: "rpc.req", id, method, params })));
  for (let i = 0; i < 400; i++) {
    const res = h.sent.find((s) => s.msg.t === "rpc.res" && s.msg.id === id);
    if (res) return res.msg;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no answer to ${method}`);
}
const code = async (method: string, params: unknown, caps?: string[]) => (await rpc(method, params, caps)).error?.code;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "omega-guest-git-")));
  repo = join(dir, "repo");
  mkdirSync(repo);
  sh("init", "-q", "-b", "main");
  write("a.txt", "one\n");
  write("b.txt", "two\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "first");
  Object.assign(h.collab, { role: "host", status: "connected", hostPeer: null, participants: [], myCaps: [] });
  Object.assign(h.app, { root: repo, tabs: [], treeVersion: 0 });
  Object.assign(h.shared, { flush: true, unsaved: false, kept: [] });
  Object.assign(git, { busy: "", repo: false, changes: [] });
  h.sent.length = 0;
  h.order.length = 0;
  h.argv.length = 0;
  h.tabText.clear();
  ui.toast.mockClear();
});
afterEach(async () => {
  for (const fn of h.endHooks) await fn();
  rmSync(dir, { recursive: true, force: true });
});

describe("what a guest can name", () => {
  test.each(["--upload-pack=x", "-c", "-x", "../up", "a/../../b", "/etc/passwd", ".git/config", "sub/.git/hooks/pre-commit", ".GIT/config", ".git./x", "git~1/config", ":(glob)**", ":/x", "a\\b", "a\0b", "a\nb", "", "./a", "a//b", "C:/x"])("path %j is refused", (p) => {
    expect(validPath(p)).toBe(false);
  });
  test.each(["a.txt", "dir/b c.txt", "ünï/côdé.md", ".gitignore", ".github/workflows/x.yml"])("path %j is fine", (p) => expect(validPath(p)).toBe(true));
  test.each(["--orphan", "-b", "-", "@{-1}", "HEAD~1", "HEAD^", "a..b", "x^{commit}", "HEAD", "@", "a b", "a:b", "a?b", "a*b", "a[b", "a\\b", ".hidden", "a/.b", "a.lock", "a/", "/a", "a//b", "a.", "x/-y", "a\nb"])("branch %j is refused", (b) => {
    expect(validBranch(b)).toBe(false);
  });
  test.each(["main", "feat/thing-1", "release-1.2", "user@work"])("branch %j is fine", (b) => expect(validBranch(b)).toBe(true));
  test("lists and messages are bounded", () => {
    expect(validPaths([])).toBeNull();
    expect(validPaths(["a", "--all"])).toBeNull();
    expect(validPaths(Array.from({ length: 2001 }, (_, i) => `f${i}`))).toBeNull();
    expect(validPaths(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(validMessage("  ")).toBe(false);
    expect(validMessage("a\0b")).toBe(false);
    expect(validMessage("x".repeat(70_000))).toBe(false);
  });
});

describe("the command lines", () => {
  test("every one carries the guard, and values never sit in an option's place", () => {
    const all = [gitArgv.stage(["a"]), gitArgv.unstage(["a"]), gitArgv.commit("m", ["a"]), gitArgv.discard(["a"]), gitArgv.forget("a"), gitArgv.createBranch("b"), gitArgv.switchLocal("b"), gitArgv.switchTrack("origin/b"), gitArgv.fetch([]), gitArgv.pull([]), gitArgv.push([], "b"), gitArgv.blob("HEAD:a")];
    for (const argv of all) expect(argv.slice(0, GIT_GUARD.length)).toEqual([...GIT_GUARD]);
    expect(GIT_GUARD).toContain("core.hooksPath=/dev/null");
    expect(GIT_GUARD).toContain("--literal-pathspecs");
    for (const argv of [gitArgv.stage(["a"]), gitArgv.unstage(["a"]), gitArgv.commit("m", ["a"]), gitArgv.discard(["a"])]) expect(argv.indexOf("--")).toBe(argv.length - 2);
    expect(gitArgv.commit("--amend", ["a"])).toContain("--message=--amend");
  });
  test("failures become codes without the host's paths", () => {
    expect(gitFailCode("error: Your local changes to the following files would be overwritten by checkout:\n\t/home/me/x")).toBe("would_overwrite");
    expect(gitFailCode("! [rejected] main -> main (fetch first)")).toBe("rejected");
    expect(gitFailCode("fatal: something at /home/me/x")).toBe("failed");
  });
  test("changes outside the shared folder or in a git folder are dropped", () => {
    const r = scopeChanges(
      [
        { path: "sub/in.txt", x: "M", y: " ", orig: null },
        { path: "other/out.txt", x: "M", y: " ", orig: null },
        { path: "sub/new.txt", x: "R", y: " ", orig: "other/old.txt" },
        { path: "sub/.git/x", x: "?", y: "?", orig: null },
      ],
      "sub/",
      (rel) => !rel.split("/").includes(".git"),
    );
    expect(r.changes).toEqual([
      { path: "in.txt", x: "M", y: " ", orig: null },
      { path: "new.txt", x: "R", y: " ", orig: null },
    ]);
  });
  test("a long list is cut and says so", () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ path: `f${i}`, x: "?", y: "?", orig: null }));
    const r = scopeChanges(many, "", () => true);
    expect(r.changes).toHaveLength(5000);
    expect(r.truncated).toBe(true);
  });
});

describe("capabilities", () => {
  test.each(["git.fetch", "git.pull", "git.push"])("%s needs git-remote", async (m) => {
    expect(await code(m, {}, ["git"])).toBe("forbidden");
    expect(h.argv.flat()).not.toContain(m.slice(4));
  });
  test.each([
    ["git.stage", { paths: ["a.txt"] }],
    ["git.commit", { message: "m", paths: ["a.txt"] }],
    ["git.discard", { path: "a.txt" }],
    ["git.switch", { name: "main", remote: false }],
    ["git.createBranch", { name: "x" }],
    ["git.head", { path: "a.txt" }],
    ["git.diff", { path: "a.txt" }],
    ["git.blame", { path: "a.txt", contents: "" }],
    ["git.branches", {}],
  ])("%s needs git", async (m, params) => {
    expect(await code(m, params, ["git-remote"])).toBe("forbidden");
    expect(h.argv).toEqual([]);
  });
});

describe("the host refuses", () => {
  test.each([
    ["git.stage", { paths: ["--all"] }],
    ["git.stage", { paths: ["../outside"] }],
    ["git.stage", { paths: [".git/config"] }],
    ["git.discard", { path: "-f" }],
    ["git.switch", { name: "--detach", remote: false }],
    ["git.switch", { name: "@{-1}", remote: false }],
    ["git.createBranch", { name: "-D" }],
    ["git.head", { path: "../../etc/passwd" }],
    ["git.fetch", { remote: "ext::sh -c evil" }],
    ["git.pull", { url: "/tmp/evil" }],
    ["git.push", { remote: "https://evil.invalid/x.git" }],
    ["git.push", { args: ["--force"] }],
  ])("%s %j", async (m, params) => {
    expect(await code(m, params)).toBe("invalid_params");
    expect(h.argv).toEqual([]);
  });

  test("a path the status doesn't list", async () => {
    expect(await code("git.discard", { path: "b.txt" })).toBe("invalid");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
  });

  test("a symlink that leaves the project", async () => {
    writeFileSync(join(dir, "secret.txt"), "secret\n");
    symlinkSync(dir, join(repo, "out"));
    expect(await code("git.head", { path: "out/secret.txt" })).toBe("invalid");
    expect(await code("git.diff", { path: "out/secret.txt" })).toBe("invalid");
  });

  test("a branch that doesn't exist is not guessed", async () => {
    expect(await code("git.switch", { name: "nope", remote: false })).toBe("invalid");
    expect(h.order).not.toContain("git switch");
  });
});

describe("working on the repository", () => {
  test("the status topic has relative paths and no remote URL", async () => {
    mkdirSync(join(repo, "sub"));
    write("sub/in.txt", "in\n");
    write("out.txt", "out\n");
    sh("remote", "add", "origin", "https://user:token@example.invalid/x.git");
    h.app.root = join(repo, "sub");
    h.collab.participants = [{ peer: "p1", role: "guest", name: "Guest Ann", caps: ["git"] }];
    await Promise.all(h.handlers.map((fn) => fn("p1", { t: "rpc.sub", topic: "git.status" })));
    await vi.waitFor(() => expect(h.sent.some((s) => s.msg.t === "rpc.pub")).toBe(true), { timeout: 3000 });
    const pub = h.sent.find((s) => s.msg.t === "rpc.pub")!.msg;
    expect(pub.payload.changes.map((c: any) => c.path)).toEqual(["in.txt"]);
    const json = JSON.stringify(pub);
    expect(json).not.toContain(dir);
    expect(json).not.toContain("token");
    expect(pub.payload.hasRemote).toBe(true);
  });

  test("commit takes only the chosen files, under the host's name, and runs no hook", async () => {
    // A guest can edit tracked files, so a tracked hooks folder would be code on the host.
    for (const hook of ["pre-commit", "post-commit"]) {
      write(`hooks/${hook}`, `#!/bin/sh\ntouch "${join(dir, "hook-ran")}"\n`);
      chmodSync(join(repo, `hooks/${hook}`), 0o755);
    }
    sh("add", "-A");
    sh("commit", "-q", "--no-verify", "-m", "hooks");
    sh("config", "core.hooksPath", "hooks");
    write("a.txt", "changed\n");
    write("b.txt", "also changed\n");
    write("c.txt", "new\n");
    const r = await rpc("git.commit", { message: "--amend", paths: ["a.txt", "c.txt"] });
    expect(r.ok).toBe(true);
    expect(sh("log", "-1", "--format=%s|%an")).toBe("--amend|Host Person");
    expect(sh("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["a.txt", "c.txt"]);
    expect(sh("status", "--porcelain")).toBe("M b.txt");
    expect(existsSync(join(dir, "hook-ran"))).toBe(false);
    expect(ui.toast.mock.calls.some((c: any[]) => String(c[0]).includes("Guest Ann"))).toBe(true);
  });

  test("stage and unstage change the index", async () => {
    write("a.txt", "changed\n");
    expect((await rpc("git.stage", { paths: ["a.txt"] })).ok).toBe(true);
    expect(gitRun(repo, ["status", "--porcelain"]).stdout).toBe("M  a.txt\n");
    expect((await rpc("git.unstage", { paths: ["a.txt"] })).ok).toBe(true);
    expect(gitRun(repo, ["status", "--porcelain"]).stdout).toBe(" M a.txt\n");
  });

  test("diff returns both sides and caps a large file", async () => {
    write("a.txt", "changed\n");
    const r = await rpc("git.diff", { path: "a.txt" });
    expect(r.result).toMatchObject({ head: "one\n", current: "changed\n", binary: false, tooLarge: false });
    write("big.txt", "x".repeat(2 * 1024 * 1024 + 1));
    expect((await rpc("git.diff", { path: "big.txt" })).result).toMatchObject({ head: null, current: null, tooLarge: true });
  });

  test("blame turns the textconv helper off", async () => {
    expect((await rpc("git.blame", { path: "a.txt", contents: "one\n" })).result.noTextconv).toBe(true);
  });

  test("push and fetch only use the configured remote", async () => {
    const bare = join(dir, "remote.git");
    sh("init", "-q", "--bare", bare);
    sh("remote", "add", "origin", bare);
    expect((await rpc("git.push", {})).ok).toBe(true);
    expect(gitRun(bare, ["rev-parse", "main"]).stdout.trim()).toBe(sh("rev-parse", "HEAD"));
    expect(sh("rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
    expect((await rpc("git.fetch", {})).ok).toBe(true);
    expect(ui.toast.mock.calls.filter((c: any[]) => String(c[0]).includes("Guest Ann")).length).toBe(2);
  });

  test("a second write while one runs is refused", async () => {
    git.busy = "Pushing…";
    expect(await code("git.stage", { paths: ["a.txt"] })).toBe("busy");
    git.busy = "";
  });
});

describe("open shared documents", () => {
  const branchWithOtherText = () => {
    sh("switch", "-q", "-c", "other");
    write("a.txt", "from other\n");
    sh("commit", "-qam", "other");
    sh("switch", "-q", "main");
  };

  test("switching saves shared text first, then reloads the docs for everybody", async () => {
    branchWithOtherText();
    h.order.length = 0;
    expect((await rpc("git.switch", { name: "other", remote: false })).ok).toBe(true);
    expect(h.order.indexOf("flush")).toBeLessThan(h.order.indexOf("git switch"));
    expect(h.order.indexOf("git switch")).toBeLessThan(h.order.indexOf("reload"));
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("from other\n");
  });

  test("unsaved text in a host tab is not lost: git refuses and the text stays", async () => {
    branchWithOtherText();
    const path = join(repo, "a.txt");
    h.app.tabs.push({ id: "t1", path, dirty: true });
    h.tabText.set("t1", "typed by someone\n");
    expect(await code("git.switch", { name: "other", remote: false })).toBe("would_overwrite");
    expect(sh("branch", "--show-current")).toBe("main");
    expect(readFileSync(path, "utf8")).toBe("typed by someone\n");
  });

  test("a switch stops when shared text can't be written", async () => {
    branchWithOtherText();
    h.shared.flush = false;
    expect(await code("git.switch", { name: "other", remote: false })).toBe("unsaved_text");
    expect(sh("branch", "--show-current")).toBe("main");
  });

  test("discard refuses a file with unsaved text in a host tab", async () => {
    const path = join(repo, "a.txt");
    write("a.txt", "saved change\n");
    h.app.tabs.push({ id: "t1", path, dirty: true });
    expect(await code("git.discard", { path: "a.txt" })).toBe("unsaved_text");
    expect(readFileSync(path, "utf8")).toBe("saved change\n");
  });

  test("discard refuses a background doc with unwritten text", async () => {
    write("a.txt", "saved change\n");
    h.shared.unsaved = true;
    expect(await code("git.discard", { path: "a.txt" })).toBe("unsaved_text");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("saved change\n");
  });

  test("discard restores the file, reloads the docs and names the guest", async () => {
    write("a.txt", "saved change\n");
    expect((await rpc("git.discard", { path: "a.txt" })).ok).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(h.order).toContain("reload");
    expect(ui.toast.mock.calls.some((c: any[]) => String(c[0]).includes("Guest Ann"))).toBe(true);
  });

  test("text typed while git ran is reported", async () => {
    branchWithOtherText();
    h.shared.kept = ["a.txt"];
    await rpc("git.switch", { name: "other", remote: false });
    expect(ui.toast.mock.calls.some((c: any[]) => String(c[0]).includes("a.txt"))).toBe(true);
  });
});

test("the limits leave room for a capped diff", () => {
  expect(2 * 2 * 1024 * 1024 * 3).toBeLessThan(RPC_LIMITS.maxBytes);
});
