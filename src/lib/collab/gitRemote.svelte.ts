/**
 * Code Together: the host's Git for guests. The guest's Git UI is the normal one (git.svelte.ts hands
 * its actions to `setGuestGit`); here they become typed RPC methods the host carries out.
 *
 *  - `git`: status, diff, blame, gutter and local writes. `git-remote`: fetch, pull, push, which use
 *    the host's credentials and only its configured remotes (no method takes a remote).
 *  - Guests send paths, names and messages. The argv comes from gitArgs.ts, with hooks and helpers off.
 *  - Results and error codes hold paths relative to the shared folder, never absolute ones.
 *  - Before git replaces files, all shared text is written; afterwards open docs reload for everyone.
 */
import { invoke } from "@tauri-apps/api/core";
import { collab, sessionEndHooks } from "./collab.svelte";
import { blockedByCapability, guestCan } from "./guard";
import { call, isObj, publish, registerMethod, registerTopic, rpcErrorText, RpcFail, subscribe, type RpcResult } from "./rpc.svelte";
import { flushSharedDocs, guestScope, reloadSharedDocs, sharedDocUnsaved, type GuestScope } from "./share.svelte";
import { GIT_LIMITS, SSH_BATCH, gitArgv, gitFailCode, scopeChanges, validBranch, validMessage, validPath, validPaths, type GitChange } from "./gitArgs";
import { app, pathMoved, save, syncFromDisk } from "../state.svelte";
import { fetchSettled, git, kind, refresh, setGuestGit, splitBranches, type Change } from "../git/git.svelte";
import { setRemoteHead } from "../git/gutter";
import { setRemoteBlame, type Blame } from "../git/blame.svelte";
import { onFilesChanged } from "../fsWatch.svelte";
import * as ed from "../editor";
import { fsApi } from "../api";
import { ui } from "../ui.svelte";
import { t, type Key } from "../i18n/index.svelte";

export interface GitSnapshot {
  repo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  /** More changes exist than the list holds. */
  truncated: boolean;
  operation: "" | "rebase" | "merge";
  hasCommits: boolean;
  /** Whether "origin" exists. Its URL can hold credentials and stays on the host. */
  hasRemote: boolean;
  head: string;
}

export interface GitDiff {
  head: string | null;
  current: string | null;
  orig: string | null;
  binary: boolean;
  deleted: boolean;
  tooLarge: boolean;
}

declare module "./rpc.svelte" {
  interface RpcMethods {
    "git.head": { params: { path: string }; result: string | null };
    "git.diff": { params: { path: string }; result: GitDiff };
    "git.blame": { params: { path: string; contents: string }; result: Blame | null };
    "git.branches": { params: Record<string, never>; result: { local: string[]; remote: string[] } };
    "git.stage": { params: { paths: string[] }; result: null };
    "git.unstage": { params: { paths: string[] }; result: null };
    "git.commit": { params: { message: string; paths: string[] }; result: { files: number } };
    "git.continue": { params: { message: string; paths: string[] }; result: { done: boolean; conflict: boolean } };
    "git.abort": { params: Record<string, never>; result: null };
    "git.discard": { params: { path: string }; result: null };
    "git.createBranch": { params: { name: string }; result: null };
    "git.switch": { params: { name: string; remote: boolean }; result: null };
    "git.fetch": { params: Record<string, never>; result: null };
    "git.pull": { params: Record<string, never>; result: { upToDate: boolean; conflict: boolean } };
    "git.push": { params: Record<string, never>; result: { ref: string } };
  }
  interface RpcTopics {
    "git.status": GitSnapshot;
  }
}

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}
interface HostStatus {
  repo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  operation?: "rebase" | "rebase-apply" | "merge" | null;
}

// ------------------------------------------------------------------ host: reading

const runIn = (scope: GuestScope, args: string[]) => invoke<Out>("git", { root: scope.root, args });

/** Where the shared folder sits in its repository ("" or "sub/dir/"), null outside one. */
async function repoPrefix(scope: GuestScope) {
  const r = await runIn(scope, gitArgv.prefix());
  return r.code === 0 ? r.stdout.replace(/\r?\n$/, "") : null;
}

const allowedIn = (scope: GuestScope) => (rel: string) => !!rel && scope.rel(`${scope.root}/${rel}`) === rel;

async function readStatus(scope: GuestScope) {
  const [s, prefix] = await Promise.all([invoke<HostStatus>("git_status", { root: scope.root }), repoPrefix(scope)]);
  if (!s.repo || prefix === null) return null;
  return { raw: s, prefix, ...scopeChanges(s.changes, prefix, allowedIn(scope)) };
}

async function computeSnapshot(scope: GuestScope): Promise<GitSnapshot> {
  const s = await readStatus(scope);
  if (!s) return { repo: false, branch: "", upstream: null, ahead: 0, behind: 0, changes: [], truncated: false, operation: "", hasCommits: false, hasRemote: false, head: "" };
  const [origin, head] = await Promise.all([runIn(scope, gitArgv.origin()), runIn(scope, gitArgv.headSha())]);
  return {
    repo: true,
    branch: s.raw.branch,
    upstream: s.raw.upstream,
    ahead: s.raw.ahead,
    behind: s.raw.behind,
    changes: s.changes,
    truncated: s.truncated,
    operation: s.raw.operation === "rebase-apply" ? "rebase" : (s.raw.operation ?? ""),
    hasCommits: head.code === 0,
    hasRemote: origin.code === 0,
    head: head.code === 0 ? head.stdout.trim() : "",
  };
}

let cached: GitSnapshot | null = null;
let cachedJson = "";
let publishSeq = 0;
let publishTimer: ReturnType<typeof setTimeout> | undefined;

/** Computes the status and sends it if it changed. */
async function publishNow() {
  clearTimeout(publishTimer);
  if (collab.role !== "host") return;
  const scope = guestScope();
  const seq = ++publishSeq;
  let next: GitSnapshot;
  try {
    next = scope ? await computeSnapshot(scope) : { repo: false, branch: "", upstream: null, ahead: 0, behind: 0, changes: [], truncated: false, operation: "", hasCommits: false, hasRemote: false, head: "" };
  } catch (e) {
    console.error("git status for guests", e);
    return;
  }
  if (seq !== publishSeq || collab.role !== "host" || (scope && !scope.live())) return;
  const json = JSON.stringify(next);
  if (json === cachedJson) return;
  cached = next;
  cachedJson = json;
  publish("git.status", next);
}

const STATUS_DEBOUNCE = 250;
function schedulePublish() {
  if (collab.role !== "host") return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => void publishNow(), STATUS_DEBOUNCE);
}

registerTopic({
  name: "git.status",
  capability: "git",
  snapshot: () => {
    if (!cached) schedulePublish();
    return cached;
  },
});

async function checkedPath(scope: GuestScope, rel: string) {
  if (!(await scope.check(rel)) || !scope.live()) throw new RpcFail("invalid");
}

/** The HEAD version of a project file, as it is in the object store (no filters, no textconv). */
async function headBlob(scope: GuestScope, rel: string): Promise<{ text: string | null; tooLarge: boolean }> {
  const prefix = await repoPrefix(scope);
  if (prefix === null) return { text: null, tooLarge: false };
  const spec = `HEAD:${prefix}${rel}`;
  const size = await runIn(scope, gitArgv.blobSize(spec));
  if (size.code !== 0) return { text: null, tooLarge: false };
  if (Number(size.stdout.trim()) > GIT_LIMITS.maxFile) return { text: null, tooLarge: true };
  const blob = await runIn(scope, gitArgv.blob(spec));
  return { text: blob.code === 0 ? blob.stdout : null, tooLarge: false };
}

const pathParam = (raw: unknown) => (isObj(raw) && validPath(raw.path) ? { path: raw.path } : null);
const noParams = (raw: unknown): Record<string, never> | null => (raw === null || raw === undefined || (isObj(raw) && !Object.keys(raw).length) ? {} : null);

registerMethod({
  name: "git.head",
  capability: "git",
  validate: pathParam,
  handle: async ({ path }) => {
    const scope = guestScope();
    if (!scope) throw new RpcFail("unavailable");
    await checkedPath(scope, path);
    return (await headBlob(scope, path)).text;
  },
});

registerMethod({
  name: "git.diff",
  capability: "git",
  validate: pathParam,
  handle: async ({ path }) => {
    const scope = guestScope();
    if (!scope) throw new RpcFail("unavailable");
    await checkedPath(scope, path);
    const s = await readStatus(scope);
    if (!s) throw new RpcFail("unavailable");
    const orig = s.changes.find((c) => c.path === path)?.orig ?? null;
    if (orig) await checkedPath(scope, orig);
    const base = await headBlob(scope, orig ?? path);
    const abs = scope.abs(path);
    const tab = app.tabs.find((x) => x.path === abs);
    let current: string | null = null;
    let deleted = false;
    let binary = false;
    try {
      current = tab ? ed.getText(tab.id) : await fsApi.readFile(abs);
    } catch {
      if (await fsApi.exists(abs).catch(() => false)) binary = true;
      else deleted = true;
    }
    if (!scope.live()) throw new RpcFail("unavailable");
    const tooLarge = base.tooLarge || (current?.length ?? 0) > GIT_LIMITS.maxFile;
    if (tooLarge) return { head: null, current: null, orig, binary: false, deleted, tooLarge: true };
    binary ||= !!base.text?.includes("\0") || !!current?.includes("\0");
    return binary ? { head: null, current: null, orig, binary, deleted, tooLarge: false } : { head: base.text, current, orig, binary, deleted, tooLarge: false };
  },
});

registerMethod({
  name: "git.blame",
  capability: "git",
  validate: (raw) => (isObj(raw) && validPath(raw.path) && typeof raw.contents === "string" && raw.contents.length <= GIT_LIMITS.maxFile ? { path: raw.path, contents: raw.contents } : null),
  handle: async ({ path, contents }, { signal }) => {
    const scope = guestScope();
    if (!scope) throw new RpcFail("unavailable");
    await checkedPath(scope, path);
    if (signal.aborted) return null;
    return invoke<Blame | null>("git_blame", { root: scope.root, path: scope.abs(path), contents, noTextconv: true });
  },
});

registerMethod({
  name: "git.branches",
  capability: "git",
  validate: noParams,
  handle: async () => {
    const scope = guestScope();
    if (!scope) throw new RpcFail("unavailable");
    const r = await runIn(scope, gitArgv.branches());
    if (r.code !== 0) throw new RpcFail("failed");
    return splitBranches(r.stdout);
  },
});

// ------------------------------------------------------------------ host: writing

let locked = false;
const who = (peer: string) => collab.participants.find((p) => p.peer === peer)?.name ?? t("ai.collab.guest");

/** One git write at a time, and never next to one of the host's. Everybody sees the result. */
async function writeOp<T>(peer: string, signal: AbortSignal, busy: Key, announce: Key | null, fn: (scope: GuestScope, step: () => void) => Promise<T>): Promise<T> {
  const scope = guestScope();
  if (!scope) throw new RpcFail("unavailable");
  if (locked || git.busy) throw new RpcFail("busy");
  locked = true;
  git.busy = t(busy);
  const step = () => {
    if (signal.aborted || !scope.live()) throw new RpcFail("unavailable");
  };
  try {
    await fetchSettled();
    step();
    const value = await fn(scope, step);
    if (announce) ui.toast(t("git.guestDid", { name: who(peer), what: t(announce) }));
    return value;
  } finally {
    locked = false;
    git.busy = "";
    await settle(scope);
  }
}

/** After a write: the host's UI, open tabs, shared docs and the guests' status catch up. */
async function settle(scope: GuestScope) {
  if (!scope.live()) return;
  git.headVersion++;
  app.treeVersion++;
  await refresh();
  await syncFromDisk();
  const kept = await reloadSharedDocs();
  for (const file of kept) ui.toast(t("git.guestKeptTyped", { file }));
  await publishNow();
}

/** Puts all shared text on disk, so git can carry it along or refuse. Stops if any of it can't be. */
async function saveShared(scope: GuestScope) {
  for (const tab of app.tabs) {
    if (!tab.dirty || !tab.path || tab.deleted || scope.rel(tab.path) === null) continue;
    await save(tab.id);
    if (tab.dirty) throw new RpcFail("unsaved_text");
  }
  if (!(await flushSharedDocs())) throw new RpcFail("unsaved_text");
}

async function must(scope: GuestScope, args: string[]) {
  const r = await runIn(scope, args);
  if (r.code !== 0) throw new RpcFail(gitFailCode(r.stderr));
  return r;
}

/** The current changes behind `paths`; every path must be one the status lists right now. */
async function listed(scope: GuestScope, paths: string[]) {
  const s = await readStatus(scope);
  if (!s) throw new RpcFail("unavailable");
  const found: GitChange[] = [];
  for (const p of paths) {
    const c = s.changes.find((x) => x.path === p);
    if (!c) throw new RpcFail("invalid");
    await checkedPath(scope, p);
    if (c.orig) await checkedPath(scope, c.orig);
    found.push(c);
  }
  return { status: s, found, argv: found.flatMap((c) => (c.orig ? [c.orig, c.path] : [c.path])) };
}

const pathsParam = (raw: unknown) => {
  if (!isObj(raw)) return null;
  const paths = validPaths(raw.paths);
  return paths ? { paths } : null;
};

registerMethod({
  name: "git.stage",
  capability: "git",
  validate: pathsParam,
  handle: ({ paths }, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.commit", null, async (scope, step) => {
      await saveShared(scope);
      const { argv } = await listed(scope, paths);
      step();
      await must(scope, gitArgv.stage(argv));
      return null;
    }),
});

registerMethod({
  name: "git.unstage",
  capability: "git",
  validate: pathsParam,
  handle: ({ paths }, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.commit", null, async (scope, step) => {
      const { argv } = await listed(scope, paths);
      step();
      await must(scope, gitArgv.unstage(argv));
      return null;
    }),
});

registerMethod({
  name: "git.commit",
  capability: "git",
  validate: (raw) => {
    const p = pathsParam(raw);
    return p && isObj(raw) && validMessage(raw.message) ? { message: raw.message.trim(), paths: p.paths } : null;
  },
  handle: ({ message, paths }, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.commit", "git.op.commit", async (scope, step) => {
      await saveShared(scope);
      const { argv, status } = await listed(scope, paths);
      if (status.raw.operation) throw new RpcFail("conflict");
      step();
      await must(scope, gitArgv.stage(argv));
      step();
      await must(scope, gitArgv.commit(message, argv));
      return { files: paths.length };
    }),
});

registerMethod({
  name: "git.continue",
  capability: "git",
  validate: (raw) => {
    if (!isObj(raw) || typeof raw.message !== "string" || raw.message.length > GIT_LIMITS.maxMessage || raw.message.includes("\0")) return null;
    const paths = Array.isArray(raw.paths) && !raw.paths.length ? [] : validPaths(raw.paths);
    return paths ? { message: raw.message.trim(), paths } : null;
  },
  handle: ({ message, paths }, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.commit", "git.op.continue", async (scope, step) => {
      await saveShared(scope);
      const { status, found, argv } = await listed(scope, paths);
      const op = status.raw.operation;
      if (!op) throw new RpcFail("failed");
      // Like the host: markers left in a file, or a file that isn't text, are not resolved.
      for (const c of found) {
        if (kind(c as Change) !== "conflict") continue;
        const text = await fsApi.readFile(scope.abs(c.path)).catch(() => null);
        if (text === null || (/^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text))) throw new RpcFail("conflict");
      }
      step();
      if (argv.length) await must(scope, gitArgv.stage(argv));
      step();
      let r: Out;
      if (op === "merge") r = await runIn(scope, gitArgv.commitIndex(message));
      else {
        if (message && op !== "rebase-apply" && (await runIn(scope, gitArgv.stagedAny())).code === 1) await must(scope, gitArgv.commitIndex(message));
        step();
        r = await runIn(scope, gitArgv.rebaseContinue());
      }
      const after = await readStatus(scope);
      if (after?.raw.operation) return { done: false, conflict: after.changes.some((c) => kind(c as Change) === "conflict") };
      if (r.code !== 0) throw new RpcFail(gitFailCode(r.stderr));
      return { done: true, conflict: false };
    }),
});

registerMethod({
  name: "git.abort",
  capability: "git",
  validate: noParams,
  handle: (_params, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.abort", "git.op.abort", async (scope, step) => {
      await saveShared(scope);
      const s = await readStatus(scope);
      const op = s?.raw.operation;
      if (!op) throw new RpcFail("failed");
      step();
      await must(scope, gitArgv.abort(op === "merge" ? "merge" : "rebase"));
      return null;
    }),
});

registerMethod({
  name: "git.discard",
  capability: "git",
  validate: pathParam,
  handle: ({ path }, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.commit", "git.op.revert", async (scope, step) => {
      const { found, argv } = await listed(scope, [path]);
      const abs = scope.abs(path);
      // Discarding means the file's text goes. Text that isn't even saved yet wasn't in what the guest
      // confirmed, so it isn't discarded along with it.
      if (app.tabs.some((x) => x.path === abs && x.dirty) || sharedDocUnsaved(path)) throw new RpcFail("unsaved_text");
      step();
      if (kind(found[0] as Change) === "new") {
        if (await invoke<boolean>("collab_tree_has_git", { path: abs }).catch(() => true)) throw new RpcFail("invalid");
        await must(scope, gitArgv.forget(path));
        step();
        await fsApi.remove(abs);
        pathMoved(abs, null); // host tabs and shared docs keep the text as unsaved
      } else await must(scope, gitArgv.discard(argv));
      return null;
    }),
});

registerMethod({
  name: "git.createBranch",
  capability: "git",
  validate: (raw) => (isObj(raw) && validBranch(raw.name) ? { name: raw.name } : null),
  handle: ({ name }, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.switch", "git.op.createBranch", async (scope, step) => {
      await saveShared(scope);
      step();
      await must(scope, gitArgv.createBranch(name));
      return null;
    }),
});

registerMethod({
  name: "git.switch",
  capability: "git",
  validate: (raw) => (isObj(raw) && validBranch(raw.name) && typeof raw.remote === "boolean" ? { name: raw.name, remote: raw.remote } : null),
  handle: ({ name, remote }, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.switch", "git.op.switchBranch", async (scope, step) => {
      // Only a branch that exists: `switch` would otherwise guess or read it as something else.
      if ((await runIn(scope, gitArgv.hasRef(`refs/${remote ? "remotes" : "heads"}/${name}`))).code !== 0) throw new RpcFail("invalid");
      await saveShared(scope);
      step();
      await must(scope, remote ? gitArgv.switchTrack(name) : gitArgv.switchLocal(name));
      return null;
    }),
});

/** Batch-mode SSH, unless the host set up its own command. */
async function sshOpts(scope: GuestScope) {
  return (await runIn(scope, gitArgv.ownSsh())).code === 0 ? [] : SSH_BATCH;
}

registerMethod({
  name: "git.fetch",
  capability: "git-remote",
  validate: noParams,
  handle: (_params, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.fetch", "git.op.fetch", async (scope) => {
      await must(scope, gitArgv.fetch(await sshOpts(scope)));
      return null;
    }),
});

registerMethod({
  name: "git.pull",
  capability: "git-remote",
  validate: noParams,
  handle: (_params, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.pull", "git.op.pull", async (scope, step) => {
      await saveShared(scope);
      const ssh = await sshOpts(scope);
      step();
      const r = await runIn(scope, gitArgv.pull(ssh));
      if (r.code === 0) return { upToDate: /Already up to date/.test(r.stdout), conflict: false };
      if ((await readStatus(scope))?.raw.operation) return { upToDate: false, conflict: true };
      throw new RpcFail(gitFailCode(r.stderr));
    }),
});

registerMethod({
  name: "git.push",
  capability: "git-remote",
  validate: noParams,
  handle: (_params, { peer, signal }) =>
    writeOp(peer, signal, "git.busy.push", "git.op.push", async (scope, step) => {
      const s = await readStatus(scope);
      if (!s) throw new RpcFail("unavailable");
      if (s.raw.operation) throw new RpcFail("conflict");
      const upstream = s.raw.upstream;
      if (!upstream) {
        if (!validBranch(s.raw.branch)) throw new RpcFail("failed");
        if ((await runIn(scope, gitArgv.origin())).code !== 0) throw new RpcFail("no_upstream");
      }
      const ssh = await sshOpts(scope);
      step();
      await must(scope, gitArgv.push(ssh, upstream ? null : s.raw.branch));
      return { ref: upstream ?? `origin/${s.raw.branch}` };
    }),
});

// Git's own files don't show up in the file watcher, so a slow poll catches what happens outside Omega.
onFilesChanged(() => schedulePublish());
setInterval(() => {
  if (collab.role === "host" && collab.participants.length > 1 && !locked) schedulePublish();
}, 4000);

// ------------------------------------------------------------------ guest

const ERRORS: Record<string, Key> = {
  busy: "git.guestErr.busy",
  unsaved_text: "git.guestErr.unsavedText",
  conflict: "git.guestErr.conflict",
  would_overwrite: "git.guestErr.wouldOverwrite",
  nothing_to_commit: "git.guestErr.nothingToCommit",
  no_upstream: "git.guestErr.noUpstream",
  rejected: "git.guestErr.rejected",
  auth: "git.guestErr.auth",
  identity: "git.guestErr.identity",
  exists: "git.guestErr.exists",
  invalid: "git.guestErr.invalid",
  invalid_params: "git.guestErr.invalid",
  unavailable: "git.guestErr.unavailable",
  failed: "git.guestErr.failed",
};
const errorText = (code: string) => (ERRORS[code] ? t(ERRORS[code]) : rpcErrorText(code));

const LOCAL_MS = 30_000;
/** Above the SSH connect timeout, for the transfer itself. */
const NETWORK_MS = 180_000;

async function act<T>(busy: Key, what: Key, fn: () => Promise<RpcResult<T>>): Promise<{ value: T } | null> {
  if (git.busy) return null;
  git.busy = t(busy);
  try {
    const r = await fn();
    if (r.ok) return { value: r.value };
    ui.toast(t("git.failed", { what: t(what), msg: errorText(r.error.code) }), "error");
    return null;
  } finally {
    git.busy = "";
  }
}

const conflictFiles = () => git.changes.filter((c) => kind(c) === "conflict").map((c) => c.path).join(", ") || "?";
const opLabel = () => t(git.operation === "merge" ? "git.opMerge" : "git.opRebase");
const selected = () => git.changes.filter((c) => !git.excluded.includes(c.path)).map((c) => c.path);

const guestPush = async () => {
  if (blockedByCapability("git-remote") || !git.repo) return;
  if (git.operation) return void ui.toast(t(git.operation === "rebase" ? "git.pushDuringRebase" : "git.pushDuringMerge"), "error");
  if (git.branch.startsWith("HEAD (")) return void ui.toast(t("git.pushDetached"), "error");
  const r = await act("git.busy.push", "git.op.push", () => call("git.push", {}, { timeoutMs: NETWORK_MS }));
  if (r) ui.toast(t("git.pushedTo", { ref: r.value.ref }));
};

const guestContinue = async (andPush: boolean) => {
  if (blockedByCapability("git") || (andPush && blockedByCapability("git-remote"))) return;
  const op = git.operation;
  if (!op) return;
  const r = await act("git.busy.commit", "git.op.continue", () => call("git.continue", { message: git.message.trim(), paths: selected() }, { timeoutMs: LOCAL_MS }));
  if (!r) return;
  if (!r.value.done) {
    if (r.value.conflict) ui.toast(t("git.stillConflict", { files: conflictFiles(), op: opLabel() }), "error");
    return;
  }
  ui.toast(t(op === "merge" ? "git.mergeDone" : "git.rebaseDone"));
  git.message = "";
  git.excluded = [];
  if (andPush) await guestPush();
};

setGuestGit({
  active: () => collab.role === "guest",
  async commit(andPush) {
    if (git.operation) return guestContinue(andPush);
    if (blockedByCapability("git") || (andPush && blockedByCapability("git-remote"))) return;
    const paths = selected();
    if (!paths.length) return void ui.toast(t("git.noFilesSelected"), "error");
    if (!git.message.trim()) return void ui.toast(t("git.enterMessage"), "error");
    const r = await act("git.busy.commit", "git.op.commit", () => call("git.commit", { message: git.message.trim(), paths }, { timeoutMs: LOCAL_MS }));
    if (!r) return;
    ui.toast(t(r.value.files === 1 ? "git.committedOne" : "git.committedMany", { n: r.value.files }));
    git.message = "";
    git.excluded = [];
    if (andPush) await guestPush();
  },
  push: guestPush,
  async pull() {
    if (blockedByCapability("git-remote") || !git.repo) return;
    const r = await act("git.busy.pull", "git.op.pull", () => call("git.pull", {}, { timeoutMs: NETWORK_MS }));
    if (!r) return;
    if (r.value.conflict) ui.toast(t("git.pullConflict", { files: conflictFiles(), op: opLabel() }), "error");
    else ui.toast(r.value.upToDate ? t("git.upToDate") : t("git.updated"));
  },
  async fetch() {
    if (blockedByCapability("git-remote") || !git.repo) return;
    const r = await act("git.busy.fetch", "git.op.fetch", () => call("git.fetch", {}, { timeoutMs: NETWORK_MS }));
    if (!r) return;
    const ref = git.upstream ?? "origin";
    ui.toast(git.behind === 0 ? t("git.fetchedNothing") : t(git.behind === 1 ? "git.fetchedOne" : "git.fetchedMany", { n: git.behind, ref }));
  },
  continueOperation: guestContinue,
  async abortOperation() {
    if (blockedByCapability("git")) return;
    const op = git.operation;
    if (!op) return;
    if (!(await ui.confirm(t(op === "merge" ? "git.abortMergeTitle" : "git.abortRebaseTitle"), t("git.abortBody"), t("git.op.abort"), true))) return;
    const r = await act("git.busy.abort", "git.op.abort", () => call("git.abort", {}, { timeoutMs: LOCAL_MS }));
    if (r) ui.toast(t(op === "merge" ? "git.mergeAborted" : "git.rebaseAborted"));
  },
  async rollback(c) {
    if (blockedByCapability("git")) return;
    const fresh = kind(c) === "new";
    const ok = fresh
      ? await ui.confirm(t("git.deleteNewTitle", { path: c.path }), t("git.deleteNewBody"), t("common.delete"), true)
      : await ui.confirm(t("git.discardTitle", { path: c.path }), t("git.discardBody"), t("git.discard"), true);
    if (ok) await act("git.busy.commit", "git.op.revert", () => call("git.discard", { path: c.path }, { timeoutMs: LOCAL_MS }));
  },
  async branches() {
    if (!guestCan("git")) return { local: [], remote: [] };
    const r = await call("git.branches", {}, { timeoutMs: LOCAL_MS });
    return r.ok ? r.value : { local: [], remote: [] };
  },
  async switchBranch(name, remote) {
    if (blockedByCapability("git")) return;
    const r = await act("git.busy.switch", "git.op.switchBranch", () => call("git.switch", { name, remote }, { timeoutMs: LOCAL_MS }));
    if (r) ui.toast(t("git.branchToast", { name: remote ? name.slice(name.indexOf("/") + 1) : name }));
  },
  async newBranch(name) {
    if (blockedByCapability("git")) return;
    if (!validBranch(name)) return void ui.toast(t("git.failed", { what: t("git.op.createBranch"), msg: errorText("invalid") }), "error");
    const r = await act("git.busy.switch", "git.op.createBranch", () => call("git.createBranch", { name }, { timeoutMs: LOCAL_MS }));
    if (r) ui.toast(t("git.branchCreated", { name }));
  },
});

/** Guest: stage or unstage one file of the host's index. */
export async function guestStage(c: Change, on: boolean) {
  if (blockedByCapability("git")) return;
  await act("git.busy.commit", "git.op.add", () => call(on ? "git.stage" : "git.unstage", { paths: [c.path] }, { timeoutMs: LOCAL_MS }));
}

/** Whether a change has something in the index. */
export const isStaged = (c: Change) => c.x !== " " && c.x !== "?";

/** Guest: both sides of a comparison, from the host. */
export async function guestDiff(rel: string): Promise<{ ok: true; value: GitDiff } | { ok: false; message: string }> {
  const r = await call("git.diff", { path: rel }, { timeoutMs: LOCAL_MS });
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: errorText(r.error.code) };
}

setRemoteHead(async (rel) => {
  if (collab.role !== "guest" || !guestCan("git") || !validPath(rel)) return null;
  const r = await call("git.head", { path: rel }, { timeoutMs: LOCAL_MS });
  return r.ok ? r.value : null;
});

setRemoteBlame(async (rel, contents) => {
  if (collab.role !== "guest" || !guestCan("git") || !validPath(rel) || contents.length > GIT_LIMITS.maxFile) return null;
  const r = await call("git.blame", { path: rel, contents }, { timeoutMs: LOCAL_MS });
  return r.ok ? r.value : null;
});

export const guestChanges = $state({ truncated: false });
let lastHead = "";

function resetGuest() {
  lastHead = "";
  guestChanges.truncated = false;
  Object.assign(git, { repo: false, top: "", branch: "", upstream: null, ahead: 0, behind: 0, changes: [], excluded: [], remoteUrl: null, operation: "", hasCommits: true });
  git.headVersion++; // markers and blame of open tabs go too
}

subscribe("git.status", (s) => {
  if (collab.role !== "guest" && s) return;
  if (!s) {
    if (git.repo || lastHead) resetGuest();
    return;
  }
  const moved = s.head !== lastHead || s.branch !== git.branch;
  lastHead = s.head;
  guestChanges.truncated = s.truncated;
  // `remoteUrl` only says that a remote exists: the guest never gets the URL.
  Object.assign(git, { repo: s.repo, top: "", branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, changes: s.changes, operation: s.operation, hasCommits: s.hasCommits, remoteUrl: s.hasRemote ? "origin" : null });
  git.excluded = git.excluded.filter((p) => s.changes.some((c) => c.path === p));
  if (moved) git.headVersion++;
});

sessionEndHooks.push(() => {
  clearTimeout(publishTimer);
  publishSeq++;
  cached = null;
  cachedJson = "";
  locked = false;
});

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
