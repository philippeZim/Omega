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

/** Base64 to bytes, for output on its way through the mirror: no callback per byte. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A Windows path: drive letter or UNC. These compare without case and print with either slash. */
const isWindowsPath = (path: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path);

/** A path's spellings to look for: as stored and as Windows prints it. */
function spellings(path: string) {
  const clean = path.replace(/[\\/]+$/, "");
  if (isWindowsPath(clean)) return [clean];
  return [...new Set([clean, clean.replace(/\//g, "\\")])].filter((p) => p.length > 1);
}

/**
 * Matches `path` only as a whole path, so `/p/app` doesn't match inside `/p/app2` or `/x/p/app`. Also
 * after a one-letter compiler flag (`-I/p/app`), as a file URL with or without a host name, and
 * before sentence punctuation (`/p/app.`), but not as part of another name (`/p/app.bak`). Windows
 * paths also match in any case, with doubled or forward slashes and with the `\\?\` prefix.
 */
const PATH_START = `(?:(?<![\\w.\\-/\\\\])|(?<=(?:^|[\\s"'=,])-[A-Za-z]))`;
const PATH_END = `(?![\\w\\-]|\\.+[\\w\\-/\\\\])`;

function buildPathRe(path: string) {
  if (!isWindowsPath(path)) return new RegExp(`${PATH_START}(?:file://[^/\\s]*)?${escapeRe(path)}${PATH_END}([/\\\\]?)`, "g");
  const body = path.split(/[\\/]+/).map(escapeRe).join("[\\\\/]{1,2}");
  return new RegExp(`${PATH_START}(?:file://[^/\\s]*/?)?(?:\\\\{2,4}\\?\\\\{1,2})?${body}${PATH_END}([/\\\\]{0,2})`, "gi");
}

/** Compiled patterns: the mirror asks for the same few paths on every chunk of output. */
const pathRes = new Map<string, RegExp>();
function pathRe(path: string) {
  let re = pathRes.get(path);
  if (!re) {
    if (pathRes.size >= 16) pathRes.clear();
    pathRes.set(path, (re = buildPathRe(path)));
  }
  return re;
}
const pathStartRe = new RegExp(PATH_START, "y");
/** Characters before a path that decide whether it counts as one (see `PATH_START`). */
const PATH_CONTEXT = 3;

interface PathCut {
  start: number;
  end: number;
  text: string;
}

/**
 * The places in `text` naming the project or home folder, in order, with what replaces them.
 * `before` is the text just ahead of it, which only decides where a path can start.
 */
function pathCuts(body: string, root: string | null, home: string | null, before = ""): PathCut[] {
  const text = before + body;
  const cuts: PathCut[] = [];
  const scan = (paths: string[], replacement: (sep: string) => string) => {
    for (const path of paths) {
      for (const m of text.matchAll(pathRe(path))) {
        const start = m.index;
        const end = start + m[0].length;
        if (cuts.every((c) => end <= c.start || start >= c.end)) cuts.push({ start, end, text: replacement(m[1]) });
      }
    }
  };
  scan(root ? spellings(root) : [], (sep) => (sep ? "" : "."));
  scan(home ? spellings(home) : [], (sep) => `~${sep}`);
  return cuts
    .filter((c) => c.start >= before.length)
    .map((c) => ({ ...c, start: c.start - before.length, end: c.end - before.length }))
    .sort((a, b) => a.start - b.start);
}

/**
 * Host: takes the project folder and home directory out of text shown to guests: project files
 * become relative, the home directory `~`. For messages and program output only: variable values
 * and evaluation results are data and must stay exactly what the program holds.
 */
export function scrubPaths(text: string, root: string | null, home: string | null): string {
  let out = "";
  let pos = 0;
  for (const cut of pathCuts(text, root, home)) {
    out += text.slice(pos, cut.start) + cut.text;
    pos = cut.end;
  }
  return out + text.slice(pos);
}

/** Terminal escape sequences: CSI, then OSC and the other string types, then the short forms. */
const ESCAPES = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)|\x1b[ -/]*[0-~]/g;

/** Longest escape sequence held back while incomplete; a longer one is treated as plain text. */
const MAX_ESCAPE = 4096;
/** Longest host name in a `file://host/...` URL. */
const MAX_URL_HOST = 255;

/** Text without its escape sequences, and where each one was. */
function splitEscapes(text: string) {
  const seqs: { at: number; text: string }[] = [];
  let plain = "";
  let last = 0;
  for (const m of text.matchAll(ESCAPES)) {
    plain += text.slice(last, m.index);
    seqs.push({ at: plain.length, text: m[0] });
    last = m.index + m[0].length;
  }
  return { plain: plain + text.slice(last), seqs };
}

/**
 * `scrubPaths` for terminal output: colours may touch or interrupt a path, and titles and links
 * carry paths inside their sequence. Sequences inside a replaced path are kept, after it.
 */
export function scrubTerminal(text: string, root: string | null, home: string | null, before = ""): string {
  const { plain, seqs } = splitEscapes(text);
  let out = "";
  let pos = 0;
  let next = 0;
  const seqText = (seq: string) => (seq.length > 2 ? scrubPaths(seq, root, home) : seq);
  const emitTo = (end: number) => {
    for (; next < seqs.length && seqs[next].at <= end; next++) {
      out += plain.slice(pos, seqs[next].at) + seqText(seqs[next].text);
      pos = seqs[next].at;
    }
    out += plain.slice(pos, end);
    pos = end;
  };
  for (const cut of pathCuts(plain, root, home, before)) {
    emitTo(cut.start);
    out += cut.text;
    for (; next < seqs.length && seqs[next].at < cut.end; next++) out += seqText(seqs[next].text);
    pos = cut.end;
  }
  emitTo(plain.length);
  return out;
}

/** Where an escape sequence that the end of `text` leaves unfinished begins, or -1. */
export function openEscape(text: string): number {
  for (let i = Math.max(0, text.length - MAX_ESCAPE); i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0x1b && (c < 0x90 || c > 0x9f)) continue;
    const body = c === 0x1b ? i + 2 : i + 1;
    const kind = c === 0x1b ? text[i + 1] : c === 0x9b ? "[" : c === 0x9d ? "]" : c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f ? "P" : "";
    if (kind === undefined) return i; // a lone ESC at the end
    if (kind === "[") {
      const m = /^[0-?]*[ -/]*([@-~])?/.exec(text.slice(body))!;
      if (!m[1]) {
        if (body + m[0].length >= text.length) return i;
      } else i = body + m[0].length - 1;
    } else if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
      const end = text.slice(body).search(kind === "]" ? /\x07|\x1b\\|\x9c/ : /\x1b\\|\x9c/);
      if (end < 0) return i;
      i = body + end;
    } else if (c === 0x1b) {
      const m = /^[ -/]*([0-~])?/.exec(text.slice(i + 1))!;
      if (!m[1]) return i;
      i += m[0].length;
    }
  }
  return -1;
}

/** A Windows path in one form for comparing: no `\\?\` prefix, one kind of slash, lower case. */
const normalizeWindows = (path: string) => path.replace(/^\\{1,4}(?:\?\\{0,2})?/, "").replace(/[\\/]+/g, "/").toLowerCase();

/**
 * `scrubTerminal` for a byte stream: a path or an escape sequence can arrive split over two chunks,
 * so the end of a chunk that could still become one is held back until the next chunk or `flush`.
 */
export class StreamScrubber {
  private decoder = new TextDecoder();
  private tail = "";
  /** The last characters already sent, for the look-behind of what comes next. */
  private before = "";
  private needles: { text: string; windows: boolean }[];
  private firstChars: Set<string>;
  private longest: number;

  constructor(private root: string | null, private home: string | null) {
    const paths = [root, home].flatMap((p) => (p ? spellings(p) : []));
    this.needles = paths.map((p) => (isWindowsPath(p) ? { text: normalizeWindows(p), windows: true } : { text: p, windows: false }));
    const windows = this.needles.some((n) => n.windows);
    this.firstChars = new Set(["f", ...(windows ? ["F", "\\"] : []), ...paths.flatMap((p) => (isWindowsPath(p) ? [p[0].toLowerCase(), p[0].toUpperCase()] : [p[0]]))]);
    // Doubled separators can make a Windows path up to twice as long, plus the `\\?\` prefix.
    this.longest = 2 * Math.max(0, ...paths.map((p) => p.length)) + "file://".length + MAX_URL_HOST + 6;
  }

  /** Whether `rest`, the end of the text so far, could still turn into a path to scrub. */
  private couldGrow(rest: string) {
    const lower = this.needles.some((n) => n.windows) ? rest.toLowerCase() : rest;
    if ("file://".startsWith(lower)) return true;
    let path = rest;
    if (lower.startsWith("file://")) {
      const prefix = /^file:\/\/[^/\s]*/i.exec(rest)![0];
      if (prefix.length === rest.length) return prefix.length <= "file://".length + MAX_URL_HOST;
      path = rest.slice(prefix.length);
    }
    const windowsPath = normalizeWindows(path);
    const windowsNoSlash = windowsPath.replace(/^\//, "");
    return this.needles.some(({ text, windows }) => {
      for (const p of windows ? [windowsPath, windowsNoSlash] : [path]) {
        if (text.startsWith(p)) return true;
        // Dots may be punctuation or the start of another name; a separator may be doubled.
        if (p.startsWith(text) && (/^\.+$/.test(p.slice(text.length)) || (windows && p.length === text.length + 1 && p.endsWith("/")))) return true;
      }
      return false;
    });
  }

  /** Where the part that may still grow into a path begins. */
  private safeEnd(text: string) {
    const open = openEscape(text);
    const end = open >= 0 ? open : text.length;
    if (!this.needles.length) return end;
    const { plain, seqs } = splitEscapes(text.slice(0, end));
    const context = this.before + plain;
    for (let i = Math.max(0, plain.length - this.longest); i < plain.length; i++) {
      if (!this.firstChars.has(plain[i])) continue;
      pathStartRe.lastIndex = this.before.length + i;
      if (!pathStartRe.test(context) || !this.couldGrow(plain.slice(i))) continue;
      return i + seqs.filter((s) => s.at <= i).reduce((sum, s) => sum + s.text.length, 0);
    }
    return end;
  }

  /** Scrubs text that is about to go out and remembers how it ended. */
  private emit(text: string) {
    const out = scrubTerminal(text, this.root, this.home, this.before);
    this.before = (this.before + splitEscapes(text).plain).slice(-PATH_CONTEXT);
    return out;
  }

  push(bytes: Uint8Array): string {
    const text = this.tail + this.decoder.decode(bytes, { stream: true });
    const end = this.safeEnd(text);
    this.tail = text.slice(end);
    return this.emit(text.slice(0, end));
  }

  /** Output paused: releases held text, but a character split across chunks waits for its rest. */
  drain(): string {
    const text = this.tail;
    this.tail = "";
    return this.emit(text);
  }

  flush(): string {
    const text = this.tail + this.decoder.decode();
    this.tail = "";
    return this.emit(text);
  }
}

/**
 * Host: cleans what the Run and Build terminal mirrors to guests; nothing is mirrored without it.
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
