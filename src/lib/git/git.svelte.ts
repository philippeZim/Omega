/** Git integration (PyCharm-like, simple): status, commit (+push), pull, branches, rollback. */
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { app, setRoot, openFile, save, syncFromDisk } from "../state.svelte";
import { ui } from "../ui.svelte";
import { joinPath, fsApi } from "../api";

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
  if (!root) throw new Error("Kein Ordner geöffnet");
  return invoke<Out>("git", { root, args });
}

async function runOk(args: string[], what: string): Promise<Out | null> {
  const r = await run(args);
  if (r.code !== 0) {
    ui.toast(`${what} fehlgeschlagen: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`, "error");
    return null;
  }
  return r;
}

let refreshing = false;
export async function refresh() {
  if (!app.root || refreshing) {
    if (!app.root) git.repo = false;
    return;
  }
  refreshing = true;
  try {
    const s = await invoke<{ repo: boolean; top: string; branch: string; upstream: string | null; ahead: number; behind: number; changes: Change[] }>("git_status", { root: app.root });
    const headChanged = s.branch !== git.branch || s.top !== git.top;
    Object.assign(git, { repo: s.repo, top: s.top, branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, changes: s.changes });
    git.excluded = git.excluded.filter((p) => s.changes.some((c) => c.path === p));
    if (headChanged) git.headVersion++;
    if (s.repo) {
      const [remote, head] = await Promise.all([run(["remote", "get-url", "origin"], s.top), run(["rev-parse", "--verify", "-q", "HEAD"], s.top)]);
      git.remoteUrl = remote.code === 0 ? remote.stdout.trim() : null;
      git.hasCommits = head.code === 0;
    }
    syncFromDisk();
  } catch {
    git.repo = false;
  } finally {
    refreshing = false;
  }
}

/** Display status of a change: neu / geändert / gelöscht / umbenannt / Konflikt. */
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
  if (!files.length) return ui.toast("Keine Dateien ausgewählt", "error");
  if (!git.message.trim()) return ui.toast("Bitte eine Commit-Nachricht eingeben", "error");
  await saveAll();
  git.busy = "Commit …";
  try {
    // Commit exactly the ticked files (like PyCharm): reset the index, stage the selection.
    await run(["reset", "-q"]);
    const paths = files.flatMap((c) => (c.orig ? [c.orig, c.path] : [c.path]));
    if (!(await runOk(["add", "-A", "--", ...paths], "Hinzufügen"))) return;
    if (!(await runOk(["commit", "-q", "-m", git.message.trim()], "Commit"))) return;
    ui.toast(`${files.length} ${files.length === 1 ? "Datei" : "Dateien"} committet`);
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
  git.busy = "Push …";
  try {
    const args = git.upstream ? ["push"] : ["push", "-u", "origin", git.branch];
    const r = await runOk(args, "Push");
    if (r) ui.toast(`Gepusht nach ${git.upstream ?? "origin/" + git.branch}`);
  } finally {
    git.busy = "";
    await refresh();
  }
}

export async function pull() {
  if (!git.repo) return;
  await saveAll();
  git.busy = "Pull …";
  try {
    const r = await runOk(["pull", "--autostash", "--no-edit"], "Pull");
    if (r) {
      const msg = /Already up to date/.test(r.stdout) ? "Bereits aktuell" : "Aktualisiert";
      ui.toast(msg);
      git.headVersion++;
      await reloadOpenFiles();
    }
  } finally {
    git.busy = "";
    await refresh();
  }
}

/** After pull/checkout files on disk changed: reload unmodified open tabs. */
const reloadOpenFiles = () => syncFromDisk();

// ------------------------------------------------------------------ rollback

export async function rollback(c: Change) {
  const k = kind(c);
  if (k === "new") {
    const ok = await ui.confirm(`„${c.path}“ löschen?`, "Die Datei ist neu und nicht in Git – Zurücksetzen bedeutet Löschen.", "Löschen", true);
    if (!ok) return;
    await run(["rm", "-q", "--cached", "--ignore-unmatch", "--", c.path]);
    await fsApi.remove(absPath(c.path)).catch(() => {});
  } else {
    const ok = await ui.confirm(`Änderungen an „${c.path}“ verwerfen?`, "Die Datei wird auf den Stand des letzten Commits zurückgesetzt.", "Verwerfen", true);
    if (!ok) return;
    await runOk(["restore", "--staged", "--worktree", "--source=HEAD", "--", ...(c.orig ? [c.orig, c.path] : [c.path])], "Zurücksetzen");
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
  git.busy = "Wechsle Branch …";
  try {
    const args = remote ? ["switch", "--track", name] : ["switch", name];
    if (await runOk(args, "Branch wechseln")) {
      ui.toast(`Branch: ${remote ? name.slice(7) : name}`);
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
  const name = await ui.prompt("Neuer Branch", "", "feature/mein-thema");
  if (!name) return;
  if (await runOk(["switch", "-c", name.replace(/\s+/g, "-")], "Branch anlegen")) ui.toast(`Branch „${name}“ angelegt`);
  await refresh();
}

// ------------------------------------------------------------------ init / clone / publish

export async function initRepo() {
  if (!app.root) return;
  if (await runOk(["init", "-q"], "Git init")) ui.toast("Git-Repository erstellt");
  await refresh();
}

/** Clones `url` into `dest`, opens it as the workspace. Returns an error message or null. */
export async function cloneInto(url: string, dest: string): Promise<string | null> {
  const parent = dest.replace(/\/[^/]+$/, "") || "/";
  const r = await invoke<Out>("git", { root: parent, args: ["clone", url, dest] });
  if (r.code !== 0) return (r.stderr || r.stdout).trim().split("\n").filter((l) => !l.startsWith("Cloning")).pop() ?? "Klonen fehlgeschlagen";
  setRoot(dest);
  for (const f of ["README.md", "readme.md", "main.py", "src/main.rs", "src/main.py", "index.js"]) {
    if (await fsApi.exists(joinPath(dest, f))) {
      await openFile(joinPath(dest, f));
      break;
    }
  }
  ui.toast(`Geklont: ${dest.split("/").pop()}`);
  await refresh();
  return null;
}

/** Project menu / command: opens the new-project dialog on its "Aus Git klonen" tab. */
export async function cloneRepo() {
  const { runner } = await import("../code/runner.svelte");
  cloneTabRequested.value = true;
  runner.newProject = true;
}
export const cloneTabRequested = $state({ value: false });

/** Connects (or changes) the "origin" remote, e.g. an empty repository created on GitLab/GitHub. */
export async function connectRemote() {
  if (!git.repo) await initRepo();
  const url = await ui.prompt(git.remoteUrl ? "Remote ändern" : "Remote verbinden", git.remoteUrl ?? "", "git@gitlab.com:user/repo.git oder https://github.com/user/repo.git");
  if (!url || url === git.remoteUrl) return;
  const r = git.remoteUrl ? await runOk(["remote", "set-url", "origin", url], "Remote ändern") : await runOk(["remote", "add", "origin", url], "Remote verbinden");
  if (!r) return;
  ui.toast(`Verbunden mit ${url}`);
  await refresh();
  if (!git.hasCommits) {
    ui.toast("Mach zuerst einen Commit – danach kannst du pushen.");
    return;
  }
  const doPush = await ui.confirm("Jetzt pushen?", `Den Branch „${git.branch}“ zu origin hochladen und verfolgen?`, "Pushen");
  if (doPush) await push();
}

export async function publishGitHub() {
  if (!app.root) return;
  const name = await ui.prompt("Auf GitHub veröffentlichen", app.root.split("/").pop() ?? "", "Repository-Name");
  if (!name) return;
  const vis = await ui.choose("Sichtbarkeit", "Wer soll das Repository sehen können?", [
    { label: "Abbrechen", value: "cancel" },
    { label: "Öffentlich", value: "public" },
    { label: "Privat", value: "private", primary: true },
  ]);
  if (vis !== "public" && vis !== "private") return;
  if (!git.repo) await initRepo();
  // gh needs at least one commit to push.
  const head = await run(["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) {
    await run(["add", "-A"]);
    await run(["commit", "-q", "-m", "Initial commit"]);
  }
  git.busy = "Veröffentliche …";
  try {
    const r = await invoke<Out>("run_capture", { cmd: "gh", args: ["repo", "create", name, `--${vis}`, "--source", ".", "--remote", "origin", "--push"], cwd: git.top || app.root });
    if (r.code !== 0) ui.toast(`Veröffentlichen fehlgeschlagen: ${(r.stderr || r.stdout).trim().split("\n").pop()}`, "error");
    else ui.toast(`Veröffentlicht: ${r.stdout.trim().split("\n").pop()}`);
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
