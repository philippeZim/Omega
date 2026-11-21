import { onGlobalChange } from "../windowStorage";

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
/** The same for ocamllsp: Merlin runs the preprocessors a `.merlin` file or the build config names. */
const OCAML_KEY = "ocaml.guestChanged";

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

/** Stores that couldn't be written: this window's copy is the only true one. */
const unwritten = new Set<string>();

function store(key: string, map: Map<string, string>) {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
    unwritten.delete(key);
  } catch {
    // Storage is off: the pause still holds until the app closes.
    unwritten.add(key);
  }
}

/** Takes over what another window stored. Unreadable or missing data never lifts a pause. */
function refresh(key: string, map: Map<string, string>) {
  if (unwritten.has(key)) return;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return;
    const next = parseRoots(raw);
    map.clear();
    for (const [k, v] of next) map.set(k, v);
  } catch {
    // Keep what we have.
  }
}
const saveRoots = () => store(KEY, roots);

/** Without a readable store of its own, every project already paused elsewhere counts here too. */
function loadToolRoots(key: string, seeds: Map<string, string>[]) {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) return parseRoots(raw);
  } catch {
    // Unreadable: fall through.
  }
  const copy = new Map(seeds.flatMap((m) => [...m]));
  store(key, copy); // now, so a later Compile or release can't take a project out of this copy
  return copy;
}

/** A language server that executes project-controlled code, paused and released on its own. */
interface ToolPause {
  key: string;
  /** Project folder -> who changed it last, until the host allows this tool again. */
  roots: Map<string, string>;
  /** Counts guest changes, so a confirmation only covers what the host was asked about. */
  changes: number;
  /** Unsaved tab -> who wrote text in it that no folder's pause covers yet (see `toolsBeforeSave`). */
  tabs: Map<string, string>;
}
const toolPause = (key: string, seeds: Map<string, string>[]): ToolPause => ({ key, roots: loadToolRoots(key, seeds), changes: 0, tabs: new Map() });

const metals = toolPause(METALS_KEY, [roots]);
const ocaml = toolPause(OCAML_KEY, [roots, metals.roots]);
const PAUSES = { metals, ocaml };
export type PausedTool = keyof typeof PAUSES;
const allPauses = Object.values(PAUSES);

/** The pauses hold for the whole app: every decision reads what any window stored last. */
function fresh() {
  refresh(KEY, roots);
  for (const tool of allPauses) refresh(tool.key, tool.roots);
}
onGlobalChange([KEY, METALS_KEY, OCAML_KEY], () => {
  fresh();
  for (const fn of listeners) fn();
});

function pauseTool(tool: ToolPause, root: string, name: string) {
  tool.roots.set(root, name);
  store(tool.key, tool.roots);
  tool.changes++;
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
  fresh();
  const name = guestChangeHooks.name(peer);
  if (rel?.startsWith("tab:")) {
    tabs.set(rel.slice(4), name);
    // The host can save this tab as build.sbt or .merlin. Without a folder yet, the pause waits for that save.
    for (const tool of allPauses) {
      tool.tabs.set(rel.slice(4), name);
      tool.changes++;
      if (root) pauseTool(tool, root, name);
    }
  } else if (root) {
    roots.set(root, name);
    saveRoots();
    for (const tool of allPauses) pauseTool(tool, root, name);
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
  fresh();
  const tab = tabs.get(tabId);
  if (tab !== undefined) return tab;
  const root = rootOf(path) ?? (text === undefined ? undefined : rootOf(texRootOf(path, text)));
  return root === undefined ? null : roots.get(root)!;
}

/** A file or folder moved: its pause goes with it, also when it leaves the paused project. */
export function moveGuestChange(from: string, to: string | null) {
  if (to === null) return;
  fresh();
  const latexMoved = moveIn(roots, from, to);
  if (latexMoved) saveRoots();
  let toolMoved = false;
  for (const tool of allPauses) {
    if (!moveIn(tool.roots, from, to)) continue;
    store(tool.key, tool.roots);
    toolMoved = true;
  }
  if (!latexMoved && !toolMoved) return;
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

const pausedIn = (tool: ToolPause, root: string) => {
  for (const [r, name] of tool.roots) if (related(root, r)) return name;
  return null;
};

/** Who changed this project, a folder inside it or a folder around it; null if the tool may run. */
export const toolPausedBy = (tool: PausedTool, root: string): string | null => {
  fresh();
  return pausedIn(PAUSES[tool], root);
};
export const metalsPausedBy = (root: string) => toolPausedBy("metals", root);

/**
 * The host is about to write a tab to `path`. Guest text in it, or a copy of a paused project's
 * file saved elsewhere, pauses each tool for the target folder first (a running server is killed
 * by the listeners before the file exists). Returns what to call if the write fails.
 */
export function toolsBeforeSave(tabId: string, oldPath: string | null, path: string): () => void {
  fresh();
  const undo: (() => void)[] = [];
  for (const tool of allPauses) {
    const pending = tool.tabs.get(tabId);
    const name = pending ?? (oldPath && oldPath !== path ? pausedIn(tool, oldPath) : null);
    if (name === null || name === undefined) continue;
    tool.tabs.delete(tabId);
    pauseTool(tool, path.replace(/\/[^/]*$/, "") || "/", name);
    undo.push(() => {
      if (pending !== undefined && !tool.tabs.has(tabId)) tool.tabs.set(tabId, pending);
    });
  }
  if (!undo.length) return () => {};
  for (const fn of listeners) fn();
  return () => undo.forEach((fn) => fn());
}

/** Read before asking the host, and handed to `resumeTool`. */
export const toolChangeCount = (tool: PausedTool) => PAUSES[tool].changes;
export const metalsChangeCount = () => toolChangeCount("metals");

/** The host allowed this tool. False if a guest changed something since `seen`: the pause stays. */
export function resumeTool(name: PausedTool, root: string, seen: number): boolean {
  const tool = PAUSES[name];
  if (seen !== tool.changes) return false;
  fresh();
  for (const r of [...tool.roots.keys()]) if (related(root, r)) tool.roots.delete(r);
  store(tool.key, tool.roots);
  return true;
}
export const resumeMetals = (root: string, seen: number) => resumeTool("metals", root, seen);

/** The same for a guest's compile, which names a project or an unsaved tab. */
export const isPaused = (root: string | null, tabId: string | null) => {
  fresh();
  return tabId ? tabs.has(tabId) : !!root && roots.has(root);
};

/** The host pressed Compile: it accepts the text as it is now. */
export function resumeCompiling(tabId: string, path: string | null, text?: string) {
  fresh();
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
