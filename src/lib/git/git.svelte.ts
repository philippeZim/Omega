/** Git integration (PyCharm-like, simple): status, commit (+push), pull, branches, rollback. */
import { ensureTools } from "../tools.svelte";
import { invoke } from "@tauri-apps/api/core";
import { openDialog } from "../native";
import { app, setRoot, openFile, save, syncFromDisk } from "../state.svelte";
import { ui } from "../ui.svelte";
import { joinPath, fsApi } from "../api";
import { t, type Key } from "../i18n/index.svelte";
import { gitErrorMessage } from "./errors";

export interface Change {
  path: string;
  x: string;
  y: string;
  orig: string | null;
}

export const git = $state({
  repo: false,
  top: "",
  branch: "",
  upstream: null as string | null,
  ahead: 0,
  behind: 0,
  changes: [] as Change[],
  /** Paths unticked in the commit list (everything else is committed). */
  excluded: [] as string[],
  message: "",
  busy: "" as string,
  /** URL of the "origin" remote (null = no remote connected yet). */
  remoteUrl: null as string | null,
  /** False until the first commit exists. */
  hasCommits: true,
  /** Bumps when HEAD may have changed (commit, pull, branch switch) → gutter markers refetch. */
  headVersion: 0,
});

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(args: string[], root = git.top || app.root): Promise<Out> {
  if (!root) throw new Error(t("git.noFolderOpen"));
  return invoke<Out>("git", { root, args });
}

async function runOk(args: string[], what: Key): Promise<Out | null> {
  const r = await run(args);
  if (r.code !== 0) {
    ui.toast(t("git.failed", { what: t(what), msg: gitErrorMessage(r) }), "error");
    return null;
  }
  return r;
}

let refreshing = false;
/** HEAD commit seen by the last refresh ("" = none yet). */
let headSha = "";
export async function refresh() {
  if (!app.root || refreshing) {
    // No folder (closed, or a collab guest showing the host's workspace): nothing of the previous
    // repo may linger in the top bar or the Changes view.
    if (!app.root) Object.assign(git, { repo: false, top: "", branch: "", upstream: null, ahead: 0, behind: 0, changes: [], remoteUrl: null });
    return;
  }
  refreshing = true;
  try {
    const s = await invoke<{ repo: boolean; top: string; branch: string; upstream: string | null; ahead: number; behind: number; changes: Change[] }>("git_status", { root: app.root });
    let headChanged = s.branch !== git.branch || s.top !== git.top;
    Object.assign(git, { repo: s.repo, top: s.top, branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, changes: s.changes });
    git.excluded = git.excluded.filter((p) => s.changes.some((c) => c.path === p));
    if (s.repo) {
      const [remote, head] = await Promise.all([run(["remote", "get-url", "origin"], s.top), run(["rev-parse", "--verify", "-q", "HEAD"], s.top)]);
      git.remoteUrl = remote.code === 0 ? remote.stdout.trim() : null;
      git.hasCommits = head.code === 0;
      // A commit, reset or amend made outside Omega moves HEAD without changing the branch name.
      const sha = head.code === 0 ? head.stdout.trim() : "";
      if (sha !== headSha) headChanged = true;
      headSha = sha;
    }
    if (headChanged) git.headVersion++;
    syncFromDisk();
  } catch {
    git.repo = false;
  } finally {
    refreshing = false;
  }
  // Refresh runs on open, focus and every few seconds while focused: the natural place to fetch
  // when the last fetch of this repo is older than FETCH_INTERVAL.
  void autoFetch();
}

/** Display status of a change: new / modified / deleted / renamed / conflict. */
export function kind(c: Change): "new" | "modified" | "deleted" | "renamed" | "conflict" {
  if (c.x === "U" || c.y === "U" || (c.x === "A" && c.y === "A") || (c.x === "D" && c.y === "D")) return "conflict";
  if (c.x === "?" || c.x === "A") return "new";
  if (c.x === "D" || c.y === "D") return "deleted";
  if (c.x === "R") return "renamed";
  return "modified";
}

export const absPath = (rel: string) => joinPath(git.top, rel);

async function saveAll() {
  for (const t of app.tabs) if (t.dirty && t.path) await save(t.id);
}

// ------------------------------------------------------------------ commit / push / pull

export async function commit(andPush: boolean) {
  const files = git.changes.filter((c) => !git.excluded.includes(c.path));
  if (!files.length) return ui.toast(t("git.noFilesSelected"), "error");
  if (!git.message.trim()) return ui.toast(t("git.enterMessage"), "error");
  await saveAll();
  git.busy = t("git.busy.commit");
  try {
    // Commit exactly the ticked files (like PyCharm): reset the index, stage the selection.
    await run(["reset", "-q"]);
    const paths = files.flatMap((c) => (c.orig ? [c.orig, c.path] : [c.path]));
    if (!(await runOk(["add", "-A", "--", ...paths], "git.op.add"))) return;
    if (!(await runOk(["commit", "-q", "-m", git.message.trim()], "git.op.commit"))) return;
    ui.toast(t(files.length === 1 ? "git.committedOne" : "git.committedMany", { n: files.length }));
    git.message = "";
    git.excluded = [];
    git.headVersion++;
    if (andPush) await push();
  } finally {
    git.busy = "";
    await refresh();
  }
}

export async function push() {
  if (!git.repo) return;
  git.busy = t("git.busy.push");
  try {
    await fetchSettled();
    const args = git.upstream ? ["push"] : ["push", "-u", "origin", git.branch];
    const r = await runOk(args, "git.op.push");
    if (r) ui.toast(t("git.pushedTo", { ref: git.upstream ?? "origin/" + git.branch }));
  } finally {
    git.busy = "";
    await refresh();
  }
}

export async function pull() {
  if (!git.repo) return;
  await saveAll();
  git.busy = t("git.busy.pull");
  try {
    await fetchSettled();
    const r = await runOk(["pull", "--autostash", "--no-edit"], "git.op.pull");
    if (r) {
      const msg = /Already up to date/.test(r.stdout) ? t("git.upToDate") : t("git.updated");
      ui.toast(msg);
      git.headVersion++;
      await reloadOpenFiles();
    }
  } finally {
    git.busy = "";
    await refresh();
  }
}

// ------------------------------------------------------------------ fetch

/** Automatic fetches run at most this often (and only while the window has focus). */
export const FETCH_INTERVAL = 5 * 60_000;
/** A fetch that has not finished by then counts as failed (frees pull/push and the busy state). */
export const FETCH_TIMEOUT = 60_000;
let lastFetch = { top: "", at: 0 };
/** The running fetch (background or manual): pull/push wait for it instead of racing it. */
let inflight: Promise<Out | null> | null = null;

/** Runs `git <args>`, null on error or after FETCH_TIMEOUT; tracked in `inflight`. */
function startFetch(args: () => Promise<string[]>): Promise<Out | null> {
  lastFetch = { top: git.top, at: Date.now() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((res) => (timer = setTimeout(() => res(null), FETCH_TIMEOUT)));
  const p: Promise<Out | null> = Promise.race([args().then((a) => run(a)).catch(() => null), timeout]).finally(() => {
    clearTimeout(timer);
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

/**
 * Background fetch must never wait for input: SSH in batch mode with a connect timeout (unless the
 * user set their own core.sshCommand; GIT_SSH_COMMAND wins over both anyway) and no interactive
 * credential helpers. Plain `fetch` = the current branch's upstream remote.
 */
async function backgroundFetchArgs(): Promise<string[]> {
  const own = await run(["config", "--get", "core.sshCommand"]);
  const ssh = own.code === 0 ? [] : ["-c", "core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=15"];
  return [...ssh, "-c", "credential.interactive=never", "fetch", "--quiet"];
}

/** Background fetch so the behind count (↓) sees new remote commits. Silent: no toast on failure. */
export async function autoFetch() {
  if (!git.repo || !git.upstream || git.busy || inflight || !document.hasFocus()) return;
  if (lastFetch.top === git.top && Date.now() - lastFetch.at < FETCH_INTERVAL) return;
  const r = await startFetch(backgroundFetchArgs);
  if (r?.code === 0) await refresh();
}

/** Waits for a running fetch (before pull/push touch the same refs). */
const fetchSettled = async () => {
  if (inflight) await inflight;
};

/** Branch menu "Fetch": reports the result; joins a background fetch that is already running. */
export async function fetchNow() {
  if (!git.repo || git.busy) return;
  git.busy = t("git.busy.fetch");
  let r: Out | null;
  try {
    r = await (inflight ?? startFetch(async () => ["fetch", "--quiet"]));
  } finally {
    git.busy = "";
    await refresh();
  }
  if (!r) return ui.toast(t("git.failed", { what: t("git.op.fetch"), msg: t("git.fetchTimedOut") }), "error");
  if (r.code !== 0) return ui.toast(t("git.failed", { what: t("git.op.fetch"), msg: gitErrorMessage(r) }), "error");
  const ref = git.upstream ?? "origin";
  ui.toast(git.behind === 0 ? t("git.fetchedNothing") : t(git.behind === 1 ? "git.fetchedOne" : "git.fetchedMany", { n: git.behind, ref }));
}

/** After pull/checkout files on disk changed: reload unmodified open tabs. */
const reloadOpenFiles = () => syncFromDisk();

// ------------------------------------------------------------------ rollback

export async function rollback(c: Change) {
  const k = kind(c);
  if (k === "new") {
    const ok = await ui.confirm(t("git.deleteNewTitle", { path: c.path }), t("git.deleteNewBody"), t("common.delete"), true);
    if (!ok) return;
    await run(["rm", "-q", "--cached", "--ignore-unmatch", "--", c.path]);
    await fsApi.remove(absPath(c.path)).catch(() => {});
  } else {
    const ok = await ui.confirm(t("git.discardTitle", { path: c.path }), t("git.discardBody"), t("git.discard"), true);
    if (!ok) return;
    await runOk(["restore", "--staged", "--worktree", "--source=HEAD", "--", ...(c.orig ? [c.orig, c.path] : [c.path])], "git.op.revert");
  }
  app.treeVersion++;
  await reloadOpenFiles();
  await refresh();
}

// ------------------------------------------------------------------ branches

export async function branches(): Promise<{ local: string[]; remote: string[] }> {
  const r = await run(["branch", "-a", "--format=%(refname:short)"]);
  const all = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const local = all.filter((b) => !b.startsWith("origin/") && b !== "origin");
  const remote = all.filter((b) => b.startsWith("origin/") && b !== "origin/HEAD" && !local.includes(b.slice(7)));
  return { local, remote };
}

export async function switchBranch(name: string, remote = false) {
  await saveAll();
  git.busy = t("git.busy.switch");
  try {
    const args = remote ? ["switch", "--track", name] : ["switch", name];
    if (await runOk(args, "git.op.switchBranch")) {
      ui.toast(t("git.branchToast", { name: remote ? name.slice(7) : name }));
      git.headVersion++;
      app.treeVersion++;
      await reloadOpenFiles();
    }
  } finally {
    git.busy = "";
    await refresh();
  }
}

export async function newBranch() {
  const name = await ui.prompt(t("git.newBranch"), "", t("git.newBranchPlaceholder"));
  if (!name) return;
  if (await runOk(["switch", "-c", name.replace(/\s+/g, "-")], "git.op.createBranch")) ui.toast(t("git.branchCreated", { name }));
  await refresh();
}

// ------------------------------------------------------------------ init / clone / publish

export async function initRepo() {
  if (!app.root) return;
  if (!(await ensureTools(["git"], t("tools.purpose.git")))) return;
  if (await runOk(["init", "-q"], "git.op.init")) ui.toast(t("git.repoCreated"));
  await refresh();
}

/** Clones `url` into `dest`, opens it as the workspace. Returns an error message or null. */
export async function cloneInto(url: string, dest: string): Promise<string | null> {
  if (!(await ensureTools(["git"], t("tools.purpose.git")))) return t("git.cloneFailed");
  const parent = dest.replace(/\/[^/]+$/, "") || "/";
  const r = await invoke<Out>("git", { root: parent, args: ["clone", url, dest] });
  if (r.code !== 0) return gitErrorMessage(r) || t("git.cloneFailed");
  setRoot(dest);
  for (const f of ["README.md", "readme.md", "main.py", "src/main.rs", "src/main.py", "index.js"]) {
    if (await fsApi.exists(joinPath(dest, f))) {
      await openFile(joinPath(dest, f));
      break;
    }
  }
  ui.toast(t("git.cloned", { name: dest.split("/").pop() ?? dest }));
  await refresh();
  return null;
}

/** Project menu / command: opens the new-project dialog on its "Clone from Git" tab. */
export async function cloneRepo() {
  const { runner } = await import("../code/runner.svelte");
  cloneTabRequested.value = true;
  runner.newProject = true;
}
export const cloneTabRequested = $state({ value: false });

/** Connects (or changes) the "origin" remote, e.g. an empty repository created on GitLab/GitHub. */
export async function connectRemote() {
  if (!git.repo) await initRepo();
  const url = await ui.prompt(git.remoteUrl ? t("git.changeRemote") : t("git.connectRemote"), git.remoteUrl ?? "", t("git.remotePlaceholder"));
  if (!url || url === git.remoteUrl) return;
  const r = git.remoteUrl ? await runOk(["remote", "set-url", "origin", url], "git.op.changeRemote") : await runOk(["remote", "add", "origin", url], "git.op.connectRemote");
  if (!r) return;
  ui.toast(t("git.connectedTo", { url }));
  await refresh();
  if (!git.hasCommits) {
    ui.toast(t("git.commitFirst"));
    return;
  }
  const doPush = await ui.confirm(t("git.pushNowTitle"), t("git.pushNowBody", { branch: git.branch }), t("git.pushAction"));
  if (doPush) await push();
}

export async function publishGitHub() {
  if (!app.root) return;
  const name = await ui.prompt(t("git.publishGitHub"), app.root.split("/").pop() ?? "", t("git.repoName"));
  if (!name) return;
  const vis = await ui.choose(t("git.visibility"), t("git.visibilityQuestion"), [
    { label: t("common.cancel"), value: "cancel" },
    { label: t("git.public"), value: "public" },
    { label: t("git.private"), value: "private", primary: true },
  ]);
  if (vis !== "public" && vis !== "private") return;
  if (!git.repo) await initRepo();
  // gh needs at least one commit to push.
  const head = await run(["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) {
    await run(["add", "-A"]);
    await run(["commit", "-q", "-m", "Initial commit"]);
  }
  git.busy = t("git.busy.publish");
  try {
    const r = await invoke<Out>("run_capture", { cmd: "gh", args: ["repo", "create", name, `--${vis}`, "--source", ".", "--remote", "origin", "--push"], cwd: git.top || app.root });
    if (r.code !== 0) ui.toast(t("git.publishFailed", { msg: gitErrorMessage(r) }), "error");
    else ui.toast(t("git.published", { url: r.stdout.trim().split("\n").pop() ?? "" }));
  } finally {
    git.busy = "";
    await refresh();
  }
}

// ------------------------------------------------------------------ auto refresh

let poll: number | undefined;
export function startGitWatch() {
  clearInterval(poll);
  refresh();
  poll = window.setInterval(() => document.hasFocus() && refresh(), 4000);
  window.addEventListener("focus", () => refresh());
}
