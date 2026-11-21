// Code Together Git, host side: the real RPC layer and a real git repository, with a fake transport.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error No Node types in this project; the test runs under Node.
import { spawnSync } from "node:child_process";
// @ts-expect-error No Node types in this project; the test runs under Node.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
// @ts-expect-error No Node types in this project; the test runs under Node.
import { tmpdir } from "node:os";
// @ts-expect-error No Node types in this project; the test runs under Node.
import { dirname, join as nativeJoin, resolve as nativeResolve, sep } from "node:path";
import { fakeUi } from "../../test/fakes";
import { GIT_GUARD, gitArgv, gitFailCode, scopeChanges, validBranch, validMessage, validPath, validPaths } from "./gitArgs";

type Msg = Record<string, any>;
// Paths as the frontend holds them (normPath): "/" separators on Windows too.
const slashes = (p: string) => p.replace(/\\/g, "/");
const join = (...parts: string[]) => slashes(nativeJoin(...parts));
const resolve = (...parts: string[]) => slashes(nativeResolve(...parts));
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
  bounded: [] as string[],
  hooksBroken: false,
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
      readFile: async (p: string) => {
        h.order.push("readFile");
        return fs.readFileSync(p, "utf8");
      },
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
    if (cmd === "collab_hooks_check") {
      if (h.hooksBroken) throw new Error("cannot determine");
      // The real resolution is tested in collab.rs; here: the configured folder, by plain path.
      const cfg = gitRun(a.root, ["config", "--get", "core.hooksPath"]).stdout.trim();
      const dir = cfg ? resolve(a.root, cfg) : "";
      const inProject = !!dir && dir.startsWith(a.root + "/") && !dir.includes("/.git/");
      const locked = a.paths.map((p: string) => !!dir && (p === dir || p.startsWith(dir + "/")));
      const structural = a.paths.map((p: string, i: number) => locked[i] || (!!dir && dir.startsWith(p + "/")));
      return { ok: true, inProject, locked, structural };
    }
    if (cmd === "collab_read_bounded") {
      h.bounded.push(a.path);
      if (!existsSync(a.path)) return { kind: "missing" };
      if (statSync(a.path).size > a.max) return { kind: "too_large" };
      const text = readFileSync(a.path, "utf8");
      return text.includes("\0") ? { kind: "binary" } : { kind: "text", text };
    }
    if (cmd === "git_blame") return { commits: [], lines: [], noTextconv: a.noTextconv };
    throw new Error(`unexpected ${cmd}`);
  },
}));

const ID = ["-c", "user.name=Host Person", "-c", "user.email=host@example.invalid", "-c", "commit.gpgSign=false", "-c", "protocol.file.allow=always", "-c", "core.autocrlf=false"];
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
  const gitDir = gitRun(root, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
  const operation = existsSync(join(gitDir, "rebase-merge")) ? "rebase" : existsSync(join(gitDir, "rebase-apply")) ? "rebase-apply" : existsSync(join(gitDir, "MERGE_HEAD")) ? "merge" : null;
  return { repo: true, top: top.stdout.trim(), branch, upstream, ahead: 0, behind: 0, changes, operation };
}

const { RPC_LIMITS } = await import("./rpc.svelte");
await import("./gitRemote.svelte");
const { git, autoFetch } = await import("../git/git.svelte");

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

async function rpc(method: string, params: unknown, caps: string[] = ["git", "git-remote", "edit"]) {
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
  // The host's own background fetch (git.svelte.ts) is not a guest's command and has its own rules.
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  dir = slashes(realpathSync.native(mkdtempSync(join(tmpdir(), "omega-guest-git-"))));
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
  h.bounded.length = 0;
  h.hooksBroken = false;
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
  test.each(["--orphan", "-b", "-", "@{-1}", "HEAD~1", "HEAD^", "a..b", "x^{commit}", "HEAD", "@", "+main", "+refs/heads/main", "@main", "a b", "a:b", "a?b", "a*b", "a[b", "a\\b", ".hidden", "a/.b", "a.lock", "a/", "/a", "a//b", "a.", "x/-y", "a\nb"])("branch %j is refused", (b) => {
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
    const all = [gitArgv.stage(["a"]), gitArgv.unstage(["a"]), gitArgv.commit("m", ["a"]), gitArgv.discard(["a"]), gitArgv.forget("a"), gitArgv.createBranch("b"), gitArgv.switchLocal("b"), gitArgv.switchTrack("origin/b"), gitArgv.fetch([]), gitArgv.pull([]), gitArgv.push([], "origin", "b", "refs/heads/b", true), gitArgv.blob("HEAD:a")];
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

});

/** A bare remote, plus a second clone with its own identity that pushes real commits to it. */
function withRemote() {
  const bare = join(dir, "remote.git");
  const other = join(dir, "other");
  sh("init", "-q", "--bare", "-b", "main", bare);
  sh("remote", "add", "origin", bare);
  sh("push", "-q", "-u", "origin", "main");
  sh("clone", "-q", bare, other);
  const inOther = (...args: string[]) => {
    const r = gitRun(other, args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commitOther = (file: string, text: string, msg: string) => {
    writeFileSync(join(other, file), text);
    inOther("add", "-A");
    inOther("commit", "-q", "-m", msg);
    inOther("push", "-q", "origin", "main");
  };
  const remoteHead = () => gitRun(bare, ["rev-parse", "refs/heads/main"]).stdout.trim();
  return { bare, commitOther, remoteHead };
}
const commitHere = (file: string, text: string, msg: string) => {
  write(file, text);
  sh("add", "-A");
  sh("commit", "-q", "-m", msg);
};
const conflict = () => gitRun(repo, ["status", "--porcelain"]).stdout.includes("UU a.txt");

describe("push never forces", () => {
  test("a guest can't create a branch whose name is a forced refspec", async () => {
    withRemote();
    expect(await code("git.createBranch", { name: "+main" })).toBe("invalid_params");
    expect(sh("branch", "--list", "+main")).toBe("");
  });

  test("a +main branch that already exists on the host doesn't overwrite the remote's main", async () => {
    const { commitOther, remoteHead } = withRemote();
    commitOther("theirs.txt", "theirs\n", "theirs");
    const before = remoteHead();
    commitHere("mine.txt", "mine\n", "diverged");
    sh("branch", "+main");
    sh("switch", "-q", "+main");
    expect(await code("git.push", {})).toBe("invalid");
    expect(remoteHead()).toBe(before);
    expect(gitRun(join(dir, "remote.git"), ["for-each-ref", "--format=%(refname)"]).stdout.trim()).toBe("refs/heads/main");
  });

  test("a forcing refspec in the host's config doesn't apply, a diverged push is rejected", async () => {
    const { commitOther, remoteHead } = withRemote();
    commitOther("theirs.txt", "theirs\n", "theirs");
    const before = remoteHead();
    commitHere("mine.txt", "mine\n", "diverged");
    sh("config", "remote.origin.push", "+refs/heads/*:refs/heads/*");
    expect(await code("git.push", {})).toBe("rejected");
    expect(remoteHead()).toBe(before);
  });

  test("the refspec is explicit, also for a new branch, which then tracks the remote", async () => {
    const { bare } = withRemote();
    sh("switch", "-q", "-c", "topic");
    commitHere("t.txt", "t\n", "topic");
    expect((await rpc("git.push", {})).ok).toBe(true);
    expect(h.argv.find((a) => a.includes("push"))).toContain("refs/heads/topic:refs/heads/topic");
    expect(gitRun(bare, ["rev-parse", "refs/heads/topic"]).stdout.trim()).toBe(sh("rev-parse", "HEAD"));
    expect(sh("rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/topic");
  });

  test("a remote that isn't configured is never contacted", async () => {
    sh("config", "branch.main.remote", "gone");
    expect(await code("git.push", {})).toBe("no_upstream");
    expect(h.argv.some((a) => a.includes("push"))).toBe(false);
  });
});

describe("a shared subfolder of a larger repository", () => {
  const shareSub = () => {
    write("sub/in.txt", "in\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "sub");
    h.app.root = join(repo, "sub");
  };

  test.each([
    ["git.switch", { name: "other", remote: false }],
    ["git.pull", {}],
    ["git.abort", {}],
    ["git.continue", { message: "", paths: [] }],
  ])("%s is refused and touches nothing outside it", async (m, params) => {
    shareSub();
    sh("branch", "other");
    write("a.txt", "the host's unsaved work outside\n");
    const head = sh("rev-parse", "HEAD");
    h.argv.length = 0;
    expect(await code(m, params)).toBe("whole_repo");
    expect(h.argv.some((a) => a.some((x) => ["switch", "pull", "--abort", "--continue"].includes(x)))).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("the host's unsaved work outside\n");
    expect(sh("rev-parse", "HEAD")).toBe(head);
    expect(sh("branch", "--show-current")).toBe("main");
    expect(h.order).not.toContain("save");
  });

  test("stage, commit and discard stay inside it", async () => {
    shareSub();
    write("a.txt", "outside change\n");
    write("sub/in.txt", "changed\n");
    expect((await rpc("git.stage", { paths: ["in.txt"] })).ok).toBe(true);
    expect((await rpc("git.commit", { message: "inside", paths: ["in.txt"] })).ok).toBe(true);
    expect(sh("show", "--name-only", "--format=", "HEAD")).toBe("sub/in.txt");
    write("sub/in.txt", "again\n");
    expect((await rpc("git.discard", { path: "in.txt" })).ok).toBe(true);
    expect(readFileSync(join(repo, "sub/in.txt"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("outside change\n");
  });
});

describe("rewriting files needs edit", () => {
  test.each([
    ["git.discard", { path: "n.txt" }],
    ["git.switch", { name: "other", remote: false }],
    ["git.pull", {}],
    ["git.abort", {}],
    ["git.continue", { message: "", paths: [] }],
  ])("%s without edit is forbidden", async (m, params) => {
    sh("branch", "other");
    write("n.txt", "untracked\n");
    expect(await code(m, params, ["git", "git-remote"])).toBe("forbidden");
    expect(readFileSync(join(repo, "n.txt"), "utf8")).toBe("untracked\n");
    expect(sh("branch", "--show-current")).toBe("main");
  });

  test("stage and commit don't need it", async () => {
    write("a.txt", "changed\n");
    expect((await rpc("git.commit", { message: "m", paths: ["a.txt"] }, ["git"])).ok).toBe(true);
  });
});

describe("the size of a compared file", () => {
  test("a file over the limit is never read whole", async () => {
    write("big.txt", "x".repeat(2 * 1024 * 1024 + 1));
    h.order.length = 0;
    expect((await rpc("git.diff", { path: "big.txt" })).result).toMatchObject({ head: null, current: null, tooLarge: true });
    expect(h.bounded).toContain(join(repo, "big.txt"));
    expect(h.order).not.toContain("readFile");
  });
});

describe("pull, conflicts and hooks, on real clones", () => {
  const HOOKS = ["pre-commit", "commit-msg", "post-commit", "pre-merge-commit", "post-merge", "pre-rebase", "post-rewrite", "post-checkout", "pre-push", "reference-transaction"];
  /** Every hook git could run, in the folder core.hooksPath names. */
  function plantHooks() {
    mkdirSync(join(repo, ".git", "planted"), { recursive: true });
    for (const hook of HOOKS) {
      const p = join(repo, ".git", "planted", hook);
      writeFileSync(p, `#!/bin/sh\necho ${hook} >> "${join(dir, "hooks-ran")}"\n`);
      chmodSync(p, 0o755);
    }
    sh("config", "core.hooksPath", join(repo, ".git", "planted"));
    rmSync(join(dir, "hooks-ran"), { force: true });
  }
  const hooksRan = () => (existsSync(join(dir, "hooks-ran")) ? readFileSync(join(dir, "hooks-ran"), "utf8") : "");

  describe("a guest without run: what changes files pauses LaTeX auto-compile first", () => {
    const NO_RUN = ["git", "git-remote", "edit"];
    let stop: () => void;
    let changes: typeof import("./guestChanges");
    const paused = () => changes.isPaused(repo, null);
    const accept = () => changes.resumeCompiling("t", `${repo}/a.txt`);
    beforeEach(async () => {
      changes = await import("./guestChanges");
      changes.guestChangeHooks.mayRun = (peer) => !!h.collab.participants.find((p) => p.peer === peer)?.caps?.includes("run");
      stop = changes.onGuestChange(() => paused() && h.order.push("paused"));
    });
    afterEach(() => {
      stop();
      accept();
      changes.guestChangeHooks.mayRun = () => false;
    });

    test("git.switch, before the files change", async () => {
      sh("branch", "other");
      h.order.length = 0;
      expect((await rpc("git.switch", { name: "other", remote: false }, NO_RUN)).ok).toBe(true);
      expect(paused()).toBe(true);
      expect(h.order.indexOf("paused")).toBeGreaterThanOrEqual(0);
      expect(h.order.indexOf("paused")).toBeLessThan(h.order.indexOf("git switch"));
    });

    test("git.discard", async () => {
      write("a.txt", "changed\n");
      expect((await rpc("git.discard", { path: "a.txt" }, NO_RUN)).ok).toBe(true);
      expect(paused()).toBe(true);
    });

    test("git.pull, git.continue and git.abort", async () => {
      const { commitOther } = withRemote();
      commitOther("a.txt", "theirs\n", "theirs");
      commitHere("a.txt", "mine\n", "mine");
      sh("config", "pull.rebase", "false");
      expect((await rpc("git.pull", {}, NO_RUN)).result).toEqual({ upToDate: false, conflict: true });
      expect(paused()).toBe(true);
      accept();
      expect((await rpc("git.abort", {}, NO_RUN)).ok).toBe(true);
      expect(paused()).toBe(true);
      accept();
      await rpc("git.pull", {}, NO_RUN);
      accept();
      write("a.txt", "resolved\n");
      expect((await rpc("git.continue", { message: "merged", paths: ["a.txt"] }, NO_RUN)).result).toEqual({ done: true, conflict: false });
      expect(paused()).toBe(true);
    });

    test("a refused operation, reading, and a guest with run pause nothing", async () => {
      expect(await code("git.switch", { name: "nope", remote: false }, NO_RUN)).toBe("invalid");
      await rpc("git.branches", {}, NO_RUN);
      expect(paused()).toBe(false);
      sh("branch", "other");
      expect((await rpc("git.switch", { name: "other", remote: false }, [...NO_RUN, "run"])).ok).toBe(true);
      expect(paused()).toBe(false);
    });
  });

  test("a clean pull brings the commit and reloads the docs, with no hook", async () => {
    const { commitOther, remoteHead } = withRemote();
    commitOther("theirs.txt", "theirs\n", "theirs");
    plantHooks();
    h.order.length = 0;
    const r = await rpc("git.pull", {});
    expect(r.result).toEqual({ upToDate: false, conflict: false });
    expect(sh("rev-parse", "HEAD")).toBe(remoteHead());
    expect(h.order).toContain("reload");
    expect(hooksRan()).toBe("");
  });

  test("a merge conflict: pull reports it, markers are refused, continue finishes it, no hook", async () => {
    const { commitOther } = withRemote();
    commitOther("a.txt", "theirs\n", "theirs");
    commitHere("a.txt", "mine\n", "mine");
    sh("config", "pull.rebase", "false");
    plantHooks();
    expect((await rpc("git.pull", {})).result).toEqual({ upToDate: false, conflict: true });
    expect(conflict()).toBe(true);
    expect(await code("git.continue", { message: "", paths: ["a.txt"] })).toBe("conflict");
    write("a.txt", "resolved\n");
    expect((await rpc("git.continue", { message: "merged by guest", paths: ["a.txt"] })).result).toEqual({ done: true, conflict: false });
    expect(sh("log", "-1", "--format=%s|%an|%p").split("|").slice(0, 2)).toEqual(["merged by guest", "Host Person"]);
    expect(sh("log", "-1", "--format=%p").split(" ")).toHaveLength(2);
    expect(sh("status", "--porcelain")).toBe("");
    expect(hooksRan()).toBe("");
  });

  test("a rebase conflict: continue finishes it, no hook", async () => {
    const { commitOther, remoteHead } = withRemote();
    commitOther("a.txt", "theirs\n", "theirs");
    commitHere("a.txt", "mine\n", "mine");
    sh("config", "pull.rebase", "true");
    plantHooks();
    expect((await rpc("git.pull", {})).result).toEqual({ upToDate: false, conflict: true });
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(true);
    write("a.txt", "resolved\n");
    expect((await rpc("git.continue", { message: "", paths: ["a.txt"] })).result).toEqual({ done: true, conflict: false });
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(false);
    expect(sh("rev-parse", "HEAD~1")).toBe(remoteHead());
    expect(sh("log", "-1", "--format=%s")).toBe("mine");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("resolved\n");
    expect(hooksRan()).toBe("");
  });

  test.each(["false", "true"])("abort returns to the state before the pull (pull.rebase=%s)", async (rebase) => {
    const { commitOther } = withRemote();
    commitOther("a.txt", "theirs\n", "theirs");
    commitHere("a.txt", "mine\n", "mine");
    const head = sh("rev-parse", "HEAD");
    sh("config", "pull.rebase", rebase);
    plantHooks();
    expect((await rpc("git.pull", {})).result.conflict).toBe(true);
    expect((await rpc("git.abort", {})).ok).toBe(true);
    expect(sh("rev-parse", "HEAD")).toBe(head);
    expect(sh("branch", "--show-current")).toBe("main");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("mine\n");
    expect(sh("status", "--porcelain")).toBe("");
    expect(hooksRan()).toBe("");
  });

  test("pull keeps uncommitted work through its autostash", async () => {
    const { commitOther } = withRemote();
    commitOther("theirs.txt", "theirs\n", "theirs");
    sh("config", "pull.rebase", "true");
    write("a.txt", "work in progress\n");
    expect((await rpc("git.pull", {})).ok).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("work in progress\n");
    expect(existsSync(join(repo, "theirs.txt"))).toBe(true);
  });
});

describe("git hooks and guests without run", () => {
  const NO_RUN = ["git", "git-remote", "edit"];
  const WITH_RUN = [...NO_RUN, "run"];
  const husky = () => {
    write(".husky/pre-commit", "#!/bin/sh\necho original\n");
    commitHere("a.txt", "one\n", "x");
    sh("config", "core.hooksPath", ".husky");
  };

  test("discard of a hook is refused without run, allowed with it", async () => {
    husky();
    write(".husky/pre-commit", "#!/bin/sh\necho changed\n");
    expect(await code("git.discard", { path: ".husky/pre-commit" }, NO_RUN)).toBe("hooks");
    expect(readFileSync(join(repo, ".husky/pre-commit"), "utf8")).toContain("changed");
    expect((await rpc("git.discard", { path: ".husky/pre-commit" }, WITH_RUN)).ok).toBe(true);
    expect(readFileSync(join(repo, ".husky/pre-commit"), "utf8")).toContain("original");
  });

  test("discarding an ordinary file still works without run", async () => {
    husky();
    write("a.txt", "changed\n");
    expect((await rpc("git.discard", { path: "a.txt" }, NO_RUN)).ok).toBe(true);
  });

  test("a branch with another hook can't be checked out without run", async () => {
    husky();
    sh("switch", "-q", "-c", "evil");
    write(".husky/pre-commit", "#!/bin/sh\necho evil\n");
    sh("add", "-A");
    sh("commit", "-q", "--no-verify", "-m", "evil hook");
    sh("switch", "-q", "main");
    expect(await code("git.switch", { name: "evil", remote: false }, NO_RUN)).toBe("hooks");
    expect(readFileSync(join(repo, ".husky/pre-commit"), "utf8")).toContain("original");
    expect((await rpc("git.switch", { name: "evil", remote: false }, WITH_RUN)).ok).toBe(true);
  });

  test.each([["git.pull", {}], ["git.abort", {}], ["git.continue", { message: "", paths: [] }]])("%s is refused without run when hooks are in the project", async (m, params) => {
    husky();
    expect(await code(m, params, NO_RUN)).toBe("hooks");
  });

  test("if the hooks can't be determined, a guest without run is refused", async () => {
    write("a.txt", "changed\n");
    h.hooksBroken = true;
    expect(await code("git.discard", { path: "a.txt" }, NO_RUN)).toBe("hooks");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
    expect((await rpc("git.discard", { path: "a.txt" }, WITH_RUN)).ok).toBe(true);
  });

  test("the host's background fetch fires no hook, a fetch the host asks for keeps them", async () => {
    const { commitOther } = withRemote();
    mkdirSync(join(dir, "h"));
    const marker = join(dir, "ref-hook");
    writeFileSync(join(dir, "h", "reference-transaction"), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(dir, "h", "reference-transaction"), 0o755);
    commitOther("theirs.txt", "theirs\n", "one");
    sh("config", "core.hooksPath", join(dir, "h"));
    rmSync(marker, { force: true });
    Object.assign(git, { repo: true, top: repo, upstream: "origin/main", busy: "" });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    const before = sh("rev-parse", "origin/main");
    await autoFetch();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    expect(sh("rev-parse", "origin/main")).not.toBe(before); // it really fetched
    expect(existsSync(marker)).toBe(false);
    commitOther("more.txt", "more\n", "two");
    gitRun(repo, ["fetch", "--quiet"]);
    expect(existsSync(marker)).toBe(true); // the same fetch without the guard does fire it
  });

  test("a new branch in a subfolder share is refused: it would move the host's HEAD", async () => {
    write("sub/in.txt", "in\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "sub");
    h.app.root = join(repo, "sub");
    expect(await code("git.createBranch", { name: "topic" })).toBe("whole_repo");
    expect(sh("branch", "--show-current")).toBe("main");
    expect(sh("branch", "--list", "topic")).toBe("");
  });
});

test("the limits leave room for a capped diff", () => {
  expect(2 * 2 * 1024 * 1024 * 3).toBeLessThan(RPC_LIMITS.maxBytes);
});
