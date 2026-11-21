/**
 * Code Together language features: what crosses the wire, and the checks on it. Pure functions, so
 * the rules about host paths and sizes can be tested on their own.
 */

export const LSP_LIMITS = {
  diagnostics: 500,
  message: 2000,
  source: 60,
  triggers: 16,
  path: 4096,
  query: 200,
  completions: 300,
  label: 500,
  doc: 64 * 1024,
  edits: 20_000,
  fixTitle: 300,
  fixesPerDiagnostic: 8,
  symbols: 200,
  coordinate: 2 ** 31 - 1,
  /** Language documents guests can keep open on the host's servers. */
  sessions: 32,
  /** One document's diagnostics on the wire; with `sessions` far below the transport limit. */
  entryBytes: 256 * 1024,
  /** Longest text the path scrubber looks at. */
  scrubInput: 128 * 1024,
};

export interface WirePos {
  line: number;
  character: number;
}
export interface WireRange {
  start: WirePos;
  end: WirePos;
}
export interface WireDiagnostic {
  range: WireRange;
  severity?: number;
  message: string;
  source?: string;
}
/** What the server can do for a document. */
export interface LspFeatures {
  triggers: string[];
  hover: boolean;
  definition: boolean;
  format: boolean;
  codeActions: boolean;
  resolve: boolean;
}
/** One document's language state. `hash`/`len` identify the exact text it was computed for. */
export interface LspDocEntry {
  rev: number;
  hash: string;
  len: number;
  diagnostics: WireDiagnostic[];
  features: LspFeatures;
  /** Diagnostics left out to stay within the size limit. */
  truncated?: number;
  /** Why this document has no language features. */
  unavailable?: "no_server" | "limit";
}
/** `full`: replaces everything known (a snapshot). Otherwise a patch, `null` meaning the doc is gone. */
export interface LspDocsPayload {
  full?: boolean;
  docs: Record<string, LspDocEntry | null>;
}

/** Fingerprint of a text (cyrb53), to tell whether two sides talk about the same content. */
export function textHash(s: string): string {
  let a = 0xdeadbeef ^ s.length;
  let b = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

// ------------------------------------------------------------------ host paths

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slashes = (p: string) => p.replace(/\\/g, "/");
const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A folder in every spelling a server might use: raw, either slash, percent-encoded. */
function prefixSource(dir: string) {
  const segs = slashes(dir).replace(/\/+$/, "").split("/");
  const raw = segs.map(escapeRe).join("[\\\\/]");
  const encoded = segs.map((x) => escapeRe(encodeURIComponent(x))).join("(?:/|%2F|%5C)");
  return `(?:${raw}|${encoded})`;
}
const BEFORE = "(?<![\\w.-])";
const AFTER = "(?![\\w.-])";
const REST = "(?:(?:[\\\\/]|%2F|%5C)[^\\s\"'`<>|()\\[\\]{},;:*?]*)?";
const HOME_LIKE = /^(?:[a-z]:)?(?:\/var)?\/(?:home|users)\/[^/]+$/i;

export interface HostPaths {
  root: string;
  rootRe: RegExp;
  /** Every known folder with what follows it. */
  anyRe: RegExp;
  /** The known folders other than the project. */
  otherRe: RegExp | null;
  exact: Set<string>;
  users: Set<string>;
}

/** The host's folders that must not reach a guest. Case-insensitive, for Windows and macOS. */
export function hostPaths(root: string, known: string[] = []): HostPaths {
  const clean = (d: string) => slashes(d).replace(/\/+$/, "");
  const others = [...new Set(known.map(clean))].filter((d) => d.length > 1 && d !== clean(root)).sort((a, b) => b.length - a.length);
  const src = (dirs: string[]) => `${BEFORE}(?:${dirs.map(prefixSource).join("|")})${AFTER}${REST}`;
  return {
    root: clean(root),
    rootRe: new RegExp(`${BEFORE}${prefixSource(root)}${AFTER}((?:[\\\\/]|%2F|%5C)?)`, "gi"),
    anyRe: new RegExp(src([...others, clean(root)].sort((a, b) => b.length - a.length)), "gi"),
    otherRe: others.length ? new RegExp(src(others), "gi") : null,
    exact: new Set(others.map((d) => d.toLowerCase())),
    users: new Set(others.filter((d) => HOME_LIKE.test(d)).map((d) => d.split("/").pop()!.toLowerCase())),
  };
}

let lastRoot: HostPaths | null = null;
const asPaths = (p: HostPaths | string): HostPaths => {
  if (typeof p !== "string") return p;
  if (lastRoot?.root !== slashes(p).replace(/\/+$/, "")) lastRoot = hostPaths(p);
  return lastRoot;
};

/** What's left of a path outside the project: its file name, never a user name. */
function shortened(path: string, p: HostPaths) {
  const clean = slashes(path).replace(/\/+$/, "");
  const base = clean.split("/").pop() ?? "";
  if (!base || p.exact.has(clean.toLowerCase()) || p.users.has(base.toLowerCase()) || HOME_LIKE.test(clean)) return "…";
  return `…/${base}`;
}

function inProject(path: string, p: HostPaths) {
  const clean = slashes(path);
  const a = clean.toLowerCase(), r = p.root.toLowerCase();
  return a === r ? "." : a.startsWith(r + "/") ? clean.slice(r.length + 1) : null;
}

const URI = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`|)\]}]*|\bfile:\/[^\s<>"'`|)\]}]*/gi;
const WEB = /^(?:https?|ftps?):/i;
/** A path segment; folders may hold a few spaces, as they're closed by the next separator. */
const W = "[^\\s\\\\/\"'`<>|()\\[\\]{},;:*?…]+";
const DIR = `${W}(?: ${W}){0,3}`;
const E = "(?:[\\w.~+-]|%(?!2F|5C)[0-9A-Fa-f]{2})";
const GENERIC = new RegExp(
  [
    "\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s<>\"'`|)\\]}]*", // handled before: stays as it is
    `(?<![\\w.-])(?:[A-Za-z]%3A)?(?:%2F|%5C)${E}+(?:(?:%2F|%5C)${E}*)+`,
    `(?<![\\w])[A-Za-z]:[\\\\/](?:${DIR}[\\\\/])*(?:${W})?`,
    `(?<![\\w\\\\])\\\\\\\\${W}(?:[\\\\/]${W})+[\\\\/]?`,
    `(?<![\\w:/])\\/\\/${W}(?:\\/${W})+\\/?`,
    `(?<![\\w.~…/\\\\%-])(?:~[\\\\/]|\\/)(?:${DIR}[\\\\/])+(?:${W})?`,
  ].join("|"),
  "gi",
);

/**
 * Takes host paths out of a text meant for a guest to read. Project paths become relative, anything
 * else is reduced to its file name. Display text only: code to insert must never go through this.
 */
export function scrubPaths(text: string, paths: HostPaths | string): string {
  const p = asPaths(paths);
  let out = text.length > LSP_LIMITS.scrubInput ? text.slice(0, LSP_LIMITS.scrubInput) : text;
  out = out.replace(URI, (uri) => {
    if (WEB.test(uri)) return hostPathIn(uri, p) ? "…" : uri;
    const path = decoded(uri.replace(/^[a-z][a-z0-9+.-]*:\/*/i, "/")).replace(/^\/([A-Za-z]:)/, "$1");
    return inProject(path, p) ?? shortened(path, p);
  });
  out = out.replace(p.rootRe, (_m, sep: string) => (sep ? "" : "."));
  if (p.otherRe) out = out.replace(p.otherRe, (m) => shortened(decoded(m), p));
  return out.replace(GENERIC, (m) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(m) ? m : shortened(decoded(m), p)));
}

/**
 * Whether a text to insert holds a real host path. One that's already in the document (`existing`)
 * tells the guest nothing new. Look-alikes such as "/api/users/list" pass.
 */
export function hostPathIn(text: string, paths: HostPaths | string, existing = ""): boolean {
  for (const m of text.matchAll(asPaths(paths).anyRe)) if (!existing.includes(m[0])) return true;
  return false;
}

const LIBRARY = [
  /\/node_modules\//, /\/site-packages\//, /\/dist-packages\//, /\/typeshed(?:-fallback)?\//, /\/\.?venv\/lib(?:64)?\//,
  /\/lib(?:64)?\/python\d/, /\/\.cargo\/(?:registry|git)\//, /\/\.rustup\/toolchains\//, /\/lib\/rustlib\/src\//,
  /^\/usr\/(?:local\/)?include\//, /^\/usr\/lib(?:64)?\/(?:gcc|clang|llvm[^/]*|jvm)\//, /^\/opt\/homebrew\/(?:include|cellar)\//,
  /\/library\/developer\/commandlinetools\//, /\/xcode[^/]*\.app\//, /\/windows kits\//, /\/microsoft visual studio\//,
];
const NEVER = /(?:^|\/)(?:\.git|\.ssh|\.gnupg|\.aws)(?:\/|$)/i;

/** A standard library or dependency location, whose docs are as public as the package. */
export function isKnownLibrary(path: string) {
  const p = slashes(path).toLowerCase();
  return !NEVER.test(p) && LIBRARY.some((re) => re.test(p));
}

/**
 * Whether a server's text clearly quotes a place guests may not see: a file URI, or an absolute
 * path to a file or below a known host folder, outside the project and libraries.
 */
export function mentionsPrivatePath(text: string, paths: HostPaths | string): boolean {
  const p = asPaths(paths);
  const hidden = (path: string) => inProject(path, p) === null && !isKnownLibrary(path);
  for (const [uri] of text.matchAll(URI)) {
    if (!/^file:/i.test(uri)) continue;
    if (hidden(decoded(uri.replace(/^file:\/*/i, "/")).replace(/^\/([A-Za-z]:)/, "$1"))) return true;
  }
  if (p.otherRe) for (const [m] of text.matchAll(p.otherRe)) if (hidden(decoded(m))) return true;
  for (const [m] of text.matchAll(GENERIC)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(m)) continue;
    const path = decoded(m);
    if (/\.[A-Za-z0-9]{1,8}$/.test(path) && hidden(path)) return true;
  }
  return false;
}

const isCoord = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= LSP_LIMITS.coordinate;
const isPos = (p: any): p is WirePos => isCoord(p?.line) && isCoord(p?.character);
export const isRange = (r: any): r is WireRange => isPos(r?.start) && isPos(r?.end);

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A server diagnostic as guests get it: only what the editor shows, with no host paths. */
export function wireDiagnostic(d: any, root: HostPaths | string): WireDiagnostic | null {
  if (!isRange(d?.range) || typeof d.message !== "string") return null;
  const { start, end } = d.range;
  return {
    range: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } },
    ...(Number.isInteger(d.severity) ? { severity: d.severity } : {}),
    message: cut(scrubPaths(d.message, root), LSP_LIMITS.message),
    ...(typeof d.source === "string" ? { source: cut(scrubPaths(d.source, root), LSP_LIMITS.source) } : {}),
  };
}

/** As many diagnostics as fit the size limit for one document; `dropped` says how many didn't. */
export function capDiagnostics<T extends { wire: WireDiagnostic }>(list: T[]): { kept: T[]; dropped: number } {
  const encoder = new TextEncoder();
  let bytes = 0;
  const kept: T[] = [];
  for (const d of list) {
    bytes += encoder.encode(JSON.stringify(d.wire)).length + 1;
    if (bytes > LSP_LIMITS.entryBytes) break;
    kept.push(d);
  }
  return { kept, dropped: list.length - kept.length };
}

export const NO_FEATURES: LspFeatures = { triggers: [], hover: false, definition: false, format: false, codeActions: false, resolve: false };

export function wireFeatures(caps: any): LspFeatures {
  const triggers = caps?.completionProvider?.triggerCharacters;
  return {
    triggers: (Array.isArray(triggers) ? triggers : [".", ":", ">"]).filter((c: unknown) => typeof c === "string" && c.length <= 2).slice(0, LSP_LIMITS.triggers),
    hover: !!caps?.hoverProvider,
    definition: !!caps?.definitionProvider,
    format: !!caps?.documentFormattingProvider,
    codeActions: !!caps?.codeActionProvider,
    resolve: !!caps?.completionProvider?.resolveProvider,
  };
}

const isWireDiagnostic = (d: any): d is WireDiagnostic =>
  isRange(d?.range) && typeof d.message === "string" && (d.severity === undefined || Number.isInteger(d.severity)) && (d.source === undefined || typeof d.source === "string");

const isFeatures = (f: any): f is LspFeatures =>
  Array.isArray(f?.triggers) && f.triggers.every((c: unknown) => typeof c === "string") && ["hover", "definition", "format", "codeActions", "resolve"].every((k) => typeof f[k] === "boolean");

/** Guest: an entry from the host, or null if it isn't one. */
export const isDocEntry = (e: any): e is LspDocEntry =>
  Number.isSafeInteger(e?.rev) && typeof e.hash === "string" && Number.isSafeInteger(e.len) && Array.isArray(e.diagnostics) && e.diagnostics.every(isWireDiagnostic) && isFeatures(e.features) &&
  (e.truncated === undefined || Number.isSafeInteger(e.truncated)) && (e.unavailable === undefined || e.unavailable === "no_server" || e.unavailable === "limit");

// ------------------------------------------------------------------ requests

/** Identifies the exact text a request or result is about. */
export interface TextStamp {
  len: number;
  hash: string;
}
export const stampOf = (text: string): TextStamp => ({ len: text.length, hash: textHash(text) });

export const parseRel = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= LSP_LIMITS.path && !v.includes("\0") && !v.startsWith("tab:") ? v : null);
export const parseStamp = (v: any): TextStamp | null => (isCoord(v?.len) && typeof v.hash === "string" && v.hash.length <= 16 ? { len: v.len, hash: v.hash } : null);
export const parsePos = (v: any): WirePos | null => (isPos(v) ? { line: v.line, character: v.character } : null);

export interface PositionParams {
  path: string;
  at: TextStamp;
  pos: WirePos;
}
export function parsePositionParams(raw: any): PositionParams | null {
  const path = parseRel(raw?.path), at = parseStamp(raw?.at), pos = parsePos(raw?.pos);
  return path && at && pos ? { path, at, pos } : null;
}

// ------------------------------------------------------------------ results

export interface WireEdit {
  range: WireRange;
  newText: string;
}
export interface WireItem {
  id: number;
  label: string;
  filterText?: string;
  sortText?: string;
  detail?: string;
  labelDetails?: { detail?: string };
  kind?: number;
  documentation?: unknown;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: WireEdit;
  additionalTextEdits?: WireEdit[];
  /** Guest: the text `additionalTextEdits` were computed for. */
  editsBase?: TextStamp;
}
export interface WireFix {
  title: string;
  edits: WireEdit[];
}

/** Docs (a string, MarkedString, MarkupContent or a list of them) with no host paths and a size cap. */
export function wireMarkup(c: any, root: HostPaths | string): unknown {
  const text = (s: string) => cut(scrubPaths(s, root), LSP_LIMITS.doc);
  if (typeof c === "string") return text(c);
  if (Array.isArray(c)) return c.slice(0, 20).map((x) => wireMarkup(x, root)).filter((x) => x !== undefined);
  if (typeof c?.value !== "string") return undefined;
  if (c.kind === "markdown" || c.kind === "plaintext") return { kind: c.kind, value: text(c.value) };
  return { language: typeof c.language === "string" ? c.language.slice(0, 40) : "", value: text(c.value) };
}

/**
 * Edits as guests may apply them, or null if any is malformed or would write a host path into the
 * shared text. Their text is never scrubbed: changing code would corrupt it, so it's refused.
 */
export function wireEdits(list: unknown, paths: HostPaths | string, existing = ""): WireEdit[] | null {
  if (!Array.isArray(list) || list.length > LSP_LIMITS.edits) return null;
  const out: WireEdit[] = [];
  for (const e of list) {
    if (!isRange(e?.range) || typeof e.newText !== "string" || hostPathIn(e.newText, paths, existing)) return null;
    const { start, end } = e.range;
    out.push({ range: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } }, newText: e.newText });
  }
  return out;
}

/**
 * A completion item for guests, or null if it would put a host path into the text. What's shown is
 * scrubbed; what's matched and inserted stays exactly as the server wrote it.
 */
export function wireItem(item: any, id: number, paths: HostPaths | string, existing = ""): WireItem | null {
  if (typeof item?.label !== "string") return null;
  const p = asPaths(paths);
  const leaks = (s: string) => hostPathIn(s, p, existing);
  const short = (s: unknown, n = LSP_LIMITS.label) => (typeof s === "string" ? cut(scrubPaths(s, p), n) : undefined);
  const out: WireItem = { id, label: short(item.label)! };
  for (const k of ["filterText", "sortText"] as const) {
    if (typeof item[k] !== "string") continue;
    if (leaks(item[k])) return null;
    if (item[k].length <= LSP_LIMITS.label) out[k] = item[k];
  }
  if (typeof item.detail === "string") out.detail = short(item.detail, LSP_LIMITS.message);
  if (typeof item.labelDetails?.detail === "string") out.labelDetails = { detail: short(item.labelDetails.detail) };
  if (Number.isInteger(item.kind)) out.kind = item.kind;
  if (item.documentation !== undefined) out.documentation = wireMarkup(item.documentation, p);
  if (typeof item.insertText === "string") {
    if (leaks(item.insertText)) return null;
    out.insertText = item.insertText;
  }
  if (item.insertTextFormat === 1 || item.insertTextFormat === 2) out.insertTextFormat = item.insertTextFormat;
  if (item.textEdit) {
    const range = item.textEdit.range ?? item.textEdit.insert;
    const edits = wireEdits([{ range, newText: item.textEdit.newText }], p, existing);
    if (!edits) return null;
    out.textEdit = edits[0];
  }
  if (item.additionalTextEdits) {
    const edits = wireEdits(item.additionalTextEdits, p, existing);
    if (!edits) return null;
    out.additionalTextEdits = edits;
  }
  // The label doubles as filter and insertion text when the server gave neither.
  if (out.label !== item.label) {
    const labelLeaks = leaks(item.label);
    if (out.insertText === undefined && !out.textEdit) {
      if (labelLeaks) return null;
      out.insertText = item.label;
    }
    if (out.filterText === undefined && !labelLeaks && item.label.length <= LSP_LIMITS.label) out.filterText = item.label;
  }
  return out;
}
