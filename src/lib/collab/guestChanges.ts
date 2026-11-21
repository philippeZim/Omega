/**
 * Which projects hold text from a guest without `run`. TeX can read and write files, so the host
 * doesn't compile such text by itself: auto-compile pauses until the host presses Compile. Counts
 * real changes (edits of shared docs, file operations, replaces), not a guest being connected. Kept
 * across sessions and restarts: the text stays in the project after the guest has left.
 */
const KEY = "latex.guestChanged";
/**
 * The same for Metals, which executes a project's build files. Set by the same changes, released
 * on its own: Compile doesn't start Metals, and starting Metals doesn't resume LaTeX.
 */
const METALS_KEY = "metals.guestChanged";

const parseRoots = (text: string) =>
  new Map<string, string>(Object.entries(JSON.parse(text)).filter((e): e is [string, string] => typeof e[1] === "string"));

function loadRoots() {
  try {
    return parseRoots(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return new Map<string, string>();
  }
}

/** Project folder -> who changed it last. */
const roots = loadRoots();
/** Unsaved shared tab -> who changed it last. */
const tabs = new Map<string, string>();
const listeners = new Set<() => void>();

function store(key: string, map: Map<string, string>) {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Storage is off: the pause still holds until the app closes.
  }
}
const saveRoots = () => store(KEY, roots);

/** Without a readable store of its own, every project LaTeX has paused counts for Metals too. */
function loadMetalsRoots() {
  try {
    const raw = localStorage.getItem(METALS_KEY);
    if (raw !== null) return parseRoots(raw);
  } catch {
    // Unreadable: fall through.
  }
  const copy = new Map(roots);
  store(METALS_KEY, copy); // now, so a later Compile can't take a project out of this copy
  return copy;
}

/** Project folder -> who changed it last, until the host allows Metals again. */
const metalsRoots = loadMetalsRoots();
/** Counts guest changes, so a confirmation only covers what the host was asked about. */
let metalsChanges = 0;
/** Unsaved tab -> who wrote text in it that no folder's Metals pause covers yet (see `metalsBeforeSave`). */
const metalsTabs = new Map<string, string>();

function pauseMetals(root: string, name: string) {
  metalsRoots.set(root, name);
  store(METALS_KEY, metalsRoots);
  metalsChanges++;
}

/** Set by the session. Until then nobody counts as trusted. */
export const guestChangeHooks = {
  mayRun: (_peer: string) => false,
  name: (_peer: string) => "",
};

export function onGuestChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Host: a guest changed something. `rel` is the shared key ("tab:<id>" for an unsaved tab). */
export function noteGuestChange(peer: string, root: string | null, rel?: string) {
  if (guestChangeHooks.mayRun(peer)) return;
  const name = guestChangeHooks.name(peer);
  if (rel?.startsWith("tab:")) {
    tabs.set(rel.slice(4), name);
    // The host can save this tab as build.sbt. Without a folder yet, the pause waits for that save.
    metalsTabs.set(rel.slice(4), name);
    metalsChanges++;
    if (root) pauseMetals(root, name);
  } else if (root) {
    roots.set(root, name);
    saveRoots();
    pauseMetals(root, name);
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
  const latexMoved = moveIn(roots, from, to);
  const metalsMoved = moveIn(metalsRoots, from, to);
  if (latexMoved) saveRoots();
  if (metalsMoved) store(METALS_KEY, metalsRoots);
  if (!latexMoved && !metalsMoved) return;
  for (const fn of listeners) fn();
}

function moveIn(map: Map<string, string>, from: string, to: string) {
  let changed = false;
  for (const [root, name] of [...map]) {
    if (within(root, from)) {
      map.delete(root);
      map.set(to + root.slice(from.length), name);
      changed = true;
    } else if (within(from, root) && !within(to, root)) {
      map.set(to, name);
      changed = true;
    }
  }
  return changed;
}

const related = (a: string, b: string) => within(a, b) || within(b, a);

/** Who changed this project, a folder inside it or a folder around it; null if Metals may run. */
export function metalsPausedBy(root: string): string | null {
  for (const [r, name] of metalsRoots) if (related(root, r)) return name;
  return null;
}

/**
 * The host is about to write a tab to `path`. Guest text in it, or a copy of a paused project's
 * file saved elsewhere, pauses Metals for the target folder first (a running Metals is killed by
 * the listeners before the file exists). Returns what to call if the write fails.
 */
export function metalsBeforeSave(tabId: string, oldPath: string | null, path: string): () => void {
  const pending = metalsTabs.get(tabId);
  const name = pending ?? (oldPath && oldPath !== path ? metalsPausedBy(oldPath) : null);
  if (name === null || name === undefined) return () => {};
  metalsTabs.delete(tabId);
  pauseMetals(path.replace(/\/[^/]*$/, "") || "/", name);
  for (const fn of listeners) fn();
  return () => {
    if (pending !== undefined && !metalsTabs.has(tabId)) metalsTabs.set(tabId, pending);
  };
}

/** Read before asking the host, and handed to `resumeMetals`. */
export const metalsChangeCount = () => metalsChanges;

/** The host allowed Metals. False if a guest changed something since `seen`: the pause stays. */
export function resumeMetals(root: string, seen: number): boolean {
  if (seen !== metalsChanges) return false;
  for (const r of [...metalsRoots.keys()]) if (related(root, r)) metalsRoots.delete(r);
  store(METALS_KEY, metalsRoots);
  return true;
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
