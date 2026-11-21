/**
 * Code Together debugging: the pure rules for what crosses from host to guests and back (no state
 * or transport imports), so they can be tested on their own.
 */

export const DEBUG_LIMITS = {
  /** Text of one console line or display name that goes to guests. */
  lineChars: 4000,
  nameChars: 300,
  /** A variable's value or evaluation result. */
  valueChars: 64_000,
  expressionChars: 4000,
  conditionChars: 1000,
  /** Children of one variable, and their total text. */
  children: 500,
  childrenChars: 1_000_000,
  /** References handed out per stop; beyond this, further expansion is refused. */
  refs: 50_000,
  threads: 200,
  frames: 60,
  scopes: 50,
  bpFiles: 200,
  bpPerFile: 200,
  /** All shared breakpoints as JSON text: well inside the RPC limit, also with multi-byte text. */
  bpChars: 2_000_000,
  maxLine: 10_000_000,
  /** Console lines in a snapshot and in one batch. */
  consoleSnapshot: 300,
  consoleBatch: 100,
  /** Watches a guest evaluates per stop. */
  watches: 40,
  /** A watch value in a batch. */
  watchChars: 8000,
  /** Nodes a guest re-expands after a refresh. */
  reopen: 40,
};

export interface SharedBreakpoint {
  line: number;
  condition?: string;
  verified?: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A path's spellings in text: as stored (forward slashes) and as Windows prints it. */
function spellings(path: string) {
  const clean = path.replace(/[\\/]+$/, "");
  return [...new Set([clean, clean.replace(/\//g, "\\")])].filter((p) => p.length > 1);
}

/** Matches `path` only as a whole path, so `/p/app` doesn't match inside `/p/app2` or `/x/p/app`. */
const pathRe = (path: string) => new RegExp(`(?<![\\w.\\-/\\\\])(?:file://)?${escapeRe(path)}(?![\\w.\\-])([/\\\\]?)`, "g");

/**
 * Host: takes the project folder and home directory out of text shown to guests: project files
 * become relative, the home directory `~`. For messages and program output only: variable values
 * and evaluation results are data and must stay exactly what the program holds.
 */
export function scrubPaths(text: string, root: string | null, home: string | null): string {
  let out = text;
  for (const r of root ? spellings(root) : []) out = out.replace(pathRe(r), (_m, sep: string) => (sep ? "" : "."));
  for (const h of home ? spellings(home) : []) out = out.replace(pathRe(h), (_m, sep: string) => `~${sep}`);
  return out;
}

/**
 * `scrubPaths` for a byte stream (a terminal): a path can arrive split over two chunks, so the end
 * of a chunk that could still become one is held back until the next chunk or `flush`.
 */
export class StreamScrubber {
  private decoder = new TextDecoder();
  private tail = "";
  private needles: string[];

  constructor(private root: string | null, private home: string | null) {
    this.needles = [root, home].flatMap((p) => (p ? spellings(p) : [])).flatMap((p) => [p, `file://${p}`]);
  }

  /** Where the part that may still grow into a path begins (one character earlier, for the look-behind). */
  private safeEnd(text: string) {
    for (let i = Math.max(0, text.length - Math.max(...this.needles.map((n) => n.length), 0)); i < text.length; i++) {
      const rest = text.slice(i);
      if (this.needles.some((n) => n.startsWith(rest))) return Math.max(0, i - 1);
    }
    return text.length;
  }

  push(bytes: Uint8Array): string {
    const text = this.tail + this.decoder.decode(bytes, { stream: true });
    const end = this.safeEnd(text);
    this.tail = text.slice(end);
    return scrubPaths(text.slice(0, end), this.root, this.home);
  }

  flush(): string {
    const text = this.tail + this.decoder.decode();
    this.tail = "";
    return scrubPaths(text, this.root, this.home);
  }
}

/**
 * Host: lets the debugger clean what the Run terminal mirrors to guests while a debug session runs.
 * `filter` returns the chunk to send ("" for none); `later` sends text it held back.
 */
export const termOut = { filter: null as ((b64: string, later: (b64: string) => void) => string) | null };

/** Cuts text to `max` characters without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/** A relative project path a guest may name: no empty parts, dots, backslashes or unsaved-tab keys. */
export function cleanRel(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 4096 || raw.includes("\0") || raw.includes("\\")) return null;
  if (raw.startsWith("/") || raw.startsWith("tab:") || raw.startsWith("collab:") || /^[a-zA-Z]:/.test(raw)) return null;
  return raw.split("/").some((seg) => seg === "" || seg === "." || seg === "..") ? null : raw;
}

export const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** A guest's breakpoint list in checked form, bounded. Markers that collapsed onto a line are merged later. Null if invalid. */
export function cleanBreakpoints(raw: unknown): { line: number; condition?: string }[] | null {
  if (!Array.isArray(raw) || raw.length > DEBUG_LIMITS.bpPerFile) return null;
  const out: { line: number; condition?: string }[] = [];
  for (const b of raw) {
    if (typeof b !== "object" || b === null) return null;
    const { line, condition } = b as Record<string, unknown>;
    if (!Number.isSafeInteger(line) || (line as number) < 1 || (line as number) > DEBUG_LIMITS.maxLine) return null;
    if (condition !== undefined && (typeof condition !== "string" || condition.length > DEBUG_LIMITS.conditionChars)) return null;
    out.push(condition ? { line: line as number, condition } : { line: line as number });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Whether a file's list can go to guests whole: never in a cut form they would send back. */
export const shareableBreakpoints = (list: { condition?: string }[]) =>
  list.length <= DEBUG_LIMITS.bpPerFile && list.every((b) => (b.condition?.length ?? 0) <= DEBUG_LIMITS.conditionChars);

/**
 * The references the host handed out for the current stop. A guest can only use one of these, and
 * they all expire when the program moves on.
 */
export class RefTable {
  private refs = new Set<number>();
  private gen = -1;

  /** Starts over if the run state changed since the last call. */
  sync(gen: number) {
    if (gen === this.gen) return;
    this.gen = gen;
    this.refs.clear();
  }
  add(gen: number, ref: unknown) {
    this.sync(gen);
    if (isId(ref) && ref > 0 && this.refs.size < DEBUG_LIMITS.refs) this.refs.add(ref);
  }
  has(gen: number, ref: number) {
    this.sync(gen);
    return this.refs.has(ref);
  }
  clear() {
    this.refs.clear();
    this.gen = -1;
  }
}
