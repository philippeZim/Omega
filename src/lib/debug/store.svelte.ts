/** Debugger state shared by the controller, the panels and the editor extension (no imports on purpose). */

export interface Breakpoint {
  line: number;
  condition?: string;
  verified?: boolean;
  /** Code Together host: a guest added or changed this entry, so it only lasts for the session. */
  guest?: GuestMark;
}
export interface GuestMark {
  peer: string;
  /** What the host itself had here (and what gets saved); null: the guest added the entry. */
  base: { condition?: string } | null;
}
export interface Frame {
  id: number;
  name: string;
  path: string | null;
  line: number;
  column: number;
  /** Library/internal frame (shown dimmed). */
  subtle: boolean;
}
export interface VarNode {
  name: string;
  value: string;
  type?: string;
  ref: number;
  evaluateName?: string;
  /** Reference of the container (for setVariable). */
  parentRef: number;
  children: VarNode[] | null;
  expanded: boolean;
  changed?: boolean;
}
export interface Watch {
  expr: string;
  value: string;
  ref: number;
  error?: boolean;
  children: VarNode[] | null;
  expanded: boolean;
}
export type DebugStatus = "idle" | "starting" | "running" | "stopped" | "terminated";

function loadBps(): Record<string, Breakpoint[]> {
  try {
    return JSON.parse(localStorage.getItem("breakpoints") || "{}");
  } catch {
    return {};
  }
}

export const dbg = $state({
  status: "idle" as DebugStatus,
  label: "",
  stopReason: "",
  threads: [] as { id: number; name: string }[],
  threadId: null as number | null,
  frames: [] as Frame[],
  frameId: null as number | null,
  scopes: [] as VarNode[],
  watches: JSON.parse(localStorage.getItem("watches") || "[]").map((expr: string) => ({ expr, value: "", ref: 0, children: null, expanded: false })) as Watch[],
  console: [] as { text: string; kind: "out" | "err" | "info" | "error" | "build" | "input" | "result" }[],
  exec: null as { path: string; line: number } | null,
  /** Code Together: the guest whose action the session last followed ("" = the host). */
  actor: "",
  breakpoints: loadBps() as Record<string, Breakpoint[]>,
  /** Bumps whenever editor-visible debug state changes (breakpoints, execution line). */
  version: 0,
});

export const dbgHooks = {
  breakpointsChanged: (_path: string) => {},
  hover: async (_expr: string): Promise<string | null> => null,
  /** A console line was added (null: the console was cleared). */
  logged: (_line: { text: string; kind: string } | null) => {},
  /** Before a debug start saves files: lets the session write what only it holds. */
  beforeStart: async () => {},
  /** Whether this instance hosts a Code Together session. */
  hosting: () => false,
};

/** Breakpoints of a Code Together host live under this prefix on guests and never reach localStorage. */
export const SHARED_BP = "collab:";

/** Guest side of Code Together: the debugger's actions go to the host while `active()`. */
export interface DebugRemote {
  active(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  step(cmd: "continue" | "next" | "stepIn" | "stepOut"): Promise<void>;
  pause(): Promise<void>;
  selectThread(id: number): Promise<void>;
  selectFrame(f: Frame): Promise<void>;
  toggleNode(n: VarNode): Promise<void>;
  toggleWatch(i: number): Promise<void>;
  setVariable(n: VarNode, value: string): Promise<void>;
  evaluateWatches(): Promise<void>;
  replEval(expr: string): Promise<void>;
  hover(expr: string): Promise<string | null>;
  breakpointsChanged(path: string): void;
}
export const dbgRemote = { impl: null as DebugRemote | null };

/** Host: breakpoints of the host's that a guest removed. Saved as they were, back after the session. */
let guestRemoved: Record<string, { line: number; condition?: string }[]> = {};

const plain = (line: number, condition?: string) => (condition ? { line, condition } : { line });

/** What the host itself owns of an entry; a guest's addition or change is never written to disk. */
function hostOwned(b: Breakpoint) {
  if (!b.guest) return [plain(b.line, b.condition)];
  return b.guest.base ? [plain(b.line, b.guest.base.condition)] : [];
}

export function saveBreakpoints() {
  const clean: Record<string, { line: number; condition?: string }[]> = {};
  for (const p of new Set([...Object.keys(dbg.breakpoints), ...Object.keys(guestRemoved)])) {
    if (p.startsWith(SHARED_BP)) continue;
    const own = (dbg.breakpoints[p] ?? []).flatMap(hostOwned);
    const back = (guestRemoved[p] ?? []).filter((r) => !own.some((b) => b.line === r.line));
    const list = back.length ? [...own, ...back].sort((x, y) => x.line - y.line) : own;
    if (list.length) clean[p] = list;
  }
  try {
    localStorage.setItem("breakpoints", JSON.stringify(clean));
  } catch (e) {
    // Storage full or unavailable: the breakpoints still work for this run.
    console.warn("breakpoints not saved", e);
  }
}

export function saveWatches() {
  localStorage.setItem("watches", JSON.stringify(dbg.watches.map((w) => w.expr)));
}

/** Above this, lines are only matched exactly: the alignment is quadratic. */
const MAX_ALIGN = 250_000;

/**
 * For each entry of `next`, the index of the `old` entry it continues, or -1. As many entries as
 * possible are paired, in order, with the smallest line distance; equal conditions break ties.
 * Deterministic, so every side reads a shift, a deleted line or a collapse the same way.
 */
export function alignBreakpoints(old: { line: number; condition?: string }[], next: { line: number; condition?: string }[]): number[] {
  const links = new Array<number>(next.length).fill(-1);
  const n = old.length, m = next.length;
  if (!n || !m) return links;
  if (n * m > MAX_ALIGN) {
    next.forEach((b, j) => (links[j] = old.findIndex((o) => o.line === b.line)));
    return links;
  }
  const a = old.map((_, i) => i).sort((x, y) => old[x].line - old[y].line);
  const c = next.map((_, j) => j).sort((x, y) => next[x].line - next[y].line);
  const SKIP = 1e9; // above any pairing, so a pair is only left out when one side has run out
  const w = m + 1;
  const dp = new Float64Array((n + 1) * w);
  const pair = (i: number, j: number) => 2 * Math.abs(old[a[i]].line - next[c[j]].line) + ((old[a[i]].condition || "") === (next[c[j]].condition || "") ? 0 : 1);
  for (let i = n; i >= 0; i--)
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) continue;
      let best = Infinity;
      if (i < n && j < m) best = pair(i, j) + dp[(i + 1) * w + j + 1];
      if (i < n) best = Math.min(best, SKIP + dp[(i + 1) * w + j]);
      if (j < m) best = Math.min(best, SKIP + dp[i * w + j + 1]);
      dp[i * w + j] = best;
    }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (dp[i * w + j] === pair(i, j) + dp[(i + 1) * w + j + 1]) links[c[j++]] = a[i++];
    else if (dp[i * w + j] === SKIP + dp[(i + 1) * w + j]) i++;
    else j++;
  }
  return links;
}

/** One entry per line, sorted; of entries that collapsed onto a line, the first with a condition. */
export function mergeLines<T extends { line: number; condition?: string }>(lines: T[]): T[] {
  const byLine = new Map<number, T>();
  for (const l of lines) {
    const had = byLine.get(l.line);
    if (!had || (!had.condition && l.condition)) byLine.set(l.line, l);
  }
  return [...byLine.values()].sort((x, y) => x.line - y.line);
}

/**
 * `moved`: the editor reports where its markers went after a text change. While hosting that can
 * only move or drop entries, so a marker the editor still holds from a withdrawn guest entry can't
 * come back as the host's own.
 */
export function setBreakpointLines(path: string, lines: { line: number; condition?: string }[], moved = false) {
  const old = dbg.breakpoints[path] ?? [];
  if (dbgHooks.hosting() || old.some((b) => b.guest)) {
    const wanted = mergeLines(lines);
    const links = alignBreakpoints(old, wanted);
    const next: Breakpoint[] = [];
    wanted.forEach((l, i) => {
      const was = links[i] >= 0 ? old[links[i]] : undefined;
      if (!was) {
        if (!moved) next.push(plain(l.line, l.condition));
      } else if (moved || (was.condition || "") === (l.condition || "")) next.push({ ...was, line: l.line });
      // The host set another condition itself: from now on the entry is the host's.
      else next.push({ ...plain(l.line, l.condition), verified: was.verified });
    });
    if (old.length === next.length && old.every((b, i) => b.line === next[i].line && b.condition === next[i].condition)) return;
    dbg.breakpoints[path] = next;
    saveBreakpoints();
    dbgHooks.breakpointsChanged(path);
    return;
  }
  const same = old.length === lines.length && old.every((b, i) => b.line === lines[i].line && b.condition === lines[i].condition);
  if (same) return;
  dbg.breakpoints[path] = lines.map((l) => ({ ...l, verified: old.find((o) => o.line === l.line)?.verified }));
  saveBreakpoints();
  dbgHooks.breakpointsChanged(path);
}

/**
 * Host: a guest's list for a file. With `mayEdit` (`debug`) it can add, change and remove; without
 * (`edit` only) it can only carry entries along with the text, so its conditions are ignored.
 * Guest changes stay in this session. False if the list asks for more than the guest may do.
 */
export function applyGuestBreakpoints(path: string, lines: { line: number; condition?: string }[], peer: string, mayEdit: boolean): boolean {
  const old = dbg.breakpoints[path] ?? [];
  const wanted = mergeLines(lines);
  if (!mayEdit && wanted.length > old.length) return false;
  const links = alignBreakpoints(old, wanted);
  const next = wanted.map((l, i): Breakpoint => {
    const was = links[i] >= 0 ? old[links[i]] : undefined;
    if (!was) return { ...plain(l.line, l.condition), guest: { peer, base: null } };
    if (!mayEdit || (was.condition || "") === (l.condition || "")) return { ...was, line: l.line };
    const base = was.guest ? was.guest.base : was.condition ? { condition: was.condition } : {};
    return { ...plain(l.line, l.condition), verified: was.verified, guest: { peer, base } };
  });
  const kept = new Set(links);
  old.forEach((b, i) => {
    if (kept.has(i)) return;
    for (const own of hostOwned(b)) (guestRemoved[path] ??= []).push(own);
  });
  if (old.length === next.length && old.every((b, i) => b.line === next[i].line && b.condition === next[i].condition)) return true;
  dbg.breakpoints[path] = next;
  saveBreakpoints();
  dbgHooks.breakpointsChanged(path);
  return true;
}

/** Host: takes back what guests no longer allowed to debug added or changed. */
export function revertGuestBreakpoints(keep: (peer: string) => boolean) {
  for (const [path, list] of Object.entries(dbg.breakpoints)) {
    if (!list.some((b) => b.guest && !keep(b.guest.peer))) continue;
    dbg.breakpoints[path] = list.flatMap((b): Breakpoint[] => {
      if (!b.guest || keep(b.guest.peer)) return [b];
      return b.guest.base ? [{ ...plain(b.line, b.guest.base.condition), verified: b.verified }] : [];
    });
    saveBreakpoints();
    dbgHooks.breakpointsChanged(path);
  }
}

/** Host: the session ended. Guest entries go, the host's own come back as they were. */
export function endGuestBreakpoints() {
  revertGuestBreakpoints(() => false);
  const removed = guestRemoved;
  guestRemoved = {};
  for (const [path, entries] of Object.entries(removed)) {
    const list = dbg.breakpoints[path] ?? [];
    const back = mergeLines(entries).filter((r) => !list.some((b) => b.line === r.line));
    if (!back.length) continue;
    dbg.breakpoints[path] = [...list, ...back].sort((x, y) => x.line - y.line);
    saveBreakpoints();
    dbgHooks.breakpointsChanged(path);
  }
}

/** Host: keeps a guest's breakpoint as its own, so it is saved. */
export function adoptBreakpoint(path: string, line: number) {
  const b = dbg.breakpoints[path]?.find((x) => x.line === line);
  if (!b?.guest) return;
  delete b.guest;
  saveBreakpoints();
  dbgHooks.breakpointsChanged(path);
}
