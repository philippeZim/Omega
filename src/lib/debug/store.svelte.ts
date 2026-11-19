/** Debugger state shared by the controller, the panels and the editor extension (no imports on purpose). */

export interface Breakpoint {
  line: number;
  condition?: string;
  verified?: boolean;
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
  breakpoints: loadBps() as Record<string, Breakpoint[]>,
  panel: false,
  /** Bumps whenever editor-visible debug state changes (breakpoints, execution line). */
  version: 0,
});

export const dbgHooks = {
  breakpointsChanged: (_path: string) => {},
  hover: async (_expr: string): Promise<string | null> => null,
};

export function saveBreakpoints() {
  const clean: Record<string, Breakpoint[]> = {};
  for (const [p, list] of Object.entries(dbg.breakpoints))
    if (list.length) clean[p] = list.map(({ line, condition }) => (condition ? { line, condition } : { line }));
  localStorage.setItem("breakpoints", JSON.stringify(clean));
}

export function saveWatches() {
  localStorage.setItem("watches", JSON.stringify(dbg.watches.map((w) => w.expr)));
}

export function setBreakpointLines(path: string, lines: { line: number; condition?: string }[]) {
  const old = dbg.breakpoints[path] ?? [];
  const same = old.length === lines.length && old.every((b, i) => b.line === lines[i].line && b.condition === lines[i].condition);
  if (same) return;
  dbg.breakpoints[path] = lines.map((l) => ({ ...l, verified: old.find((o) => o.line === l.line)?.verified }));
  saveBreakpoints();
  dbgHooks.breakpointsChanged(path);
}
