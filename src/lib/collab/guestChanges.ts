/**
 * Which projects hold text from a guest without `run`. TeX can read and write files, so the host
 * doesn't compile such text by itself: auto-compile pauses until the host presses Compile. Counts
 * real changes (edits of shared docs, file operations, replaces), not a guest being connected. Kept
 * across sessions and restarts: the text stays in the project after the guest has left.
 */
const KEY = "latex.guestChanged";

function loadRoots() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return new Map<string, string>(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return new Map<string, string>();
  }
}

/** Project folder -> who changed it last. */
const roots = loadRoots();
/** Unsaved shared tab -> who changed it last. */
const tabs = new Map<string, string>();
const listeners = new Set<() => void>();

function saveRoots() {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(roots)));
  } catch {
    // Storage is off: the pause still holds until the app closes.
  }
}

/** Set by the session. Until then nobody counts as trusted. */
export const guestChangeHooks = {
  mayRun: (_peer: string) => false,
  name: (_peer: string) => "",
};

export function onGuestChange(fn: () => void) {
  listeners.add(fn);
}

/** Host: a guest changed something. `rel` is the shared key ("tab:<id>" for an unsaved tab). */
export function noteGuestChange(peer: string, root: string | null, rel?: string) {
  if (guestChangeHooks.mayRun(peer)) return;
  const name = guestChangeHooks.name(peer);
  if (rel?.startsWith("tab:")) tabs.set(rel.slice(4), name);
  else if (root) {
    roots.set(root, name);
    saveRoots();
  } else return;
  for (const fn of listeners) fn();
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
const rootOf = (path: string | null) => (path ? [...roots.keys()].find((r) => within(path, r)) : undefined);

/** The target of a `% !TEX root = …` comment: what gets compiled when it isn't the file itself. */
export function texRootOf(path: string | null, text: string): string | null {
  if (!path) return null;
  for (const line of text.split("\n", 10)) {
    const m = /^!T[Ee]X root[ =]*(.*)$/.exec(line.replace(/^%+/, "").trim());
    if (!m) continue;
    const target = m[1].trim();
    const parts = (target.startsWith("/") ? target : `${path.replace(/\/[^/]*$/, "")}/${target}`).split("/");
    const out: string[] = [];
    for (const seg of parts) {
      if (seg === "..") {
        if (out.length > 1) out.pop();
      } else if (seg !== ".") out.push(seg);
    }
    return out.join("/");
  }
  return null;
}

/**
 * Who changed the document of this tab, or null if it may compile by itself. With the text, this
 * also looks at the root it names, so a tab elsewhere can't compile a paused project through it.
 */
export function pausedBy(tabId: string, path: string | null, text?: string): string | null {
  const tab = tabs.get(tabId);
  if (tab !== undefined) return tab;
  const root = rootOf(path) ?? (text === undefined ? undefined : rootOf(texRootOf(path, text)));
  return root === undefined ? null : roots.get(root)!;
}

/** A file or folder moved: its pause goes with it, also when it leaves the paused project. */
export function moveGuestChange(from: string, to: string | null) {
  if (to === null) return;
  let changed = false;
  for (const [root, name] of [...roots]) {
    if (within(root, from)) {
      roots.delete(root);
      roots.set(to + root.slice(from.length), name);
      changed = true;
    } else if (within(from, root) && !within(to, root)) {
      roots.set(to, name);
      changed = true;
    }
  }
  if (!changed) return;
  saveRoots();
  for (const fn of listeners) fn();
}

/** The same for a guest's compile, which names a project or an unsaved tab. */
export const isPaused = (root: string | null, tabId: string | null) => (tabId ? tabs.has(tabId) : !!root && roots.has(root));

/** The host pressed Compile: it accepts the text as it is now. */
export function resumeCompiling(tabId: string, path: string | null, text?: string) {
  tabs.delete(tabId);
  const targets = [path, text === undefined ? null : texRootOf(path, text)];
  let changed = false;
  for (const p of targets) {
    const root = rootOf(p);
    if (root !== undefined) changed = roots.delete(root) || changed;
  }
  if (changed) saveRoots();
  for (const fn of listeners) fn();
}
