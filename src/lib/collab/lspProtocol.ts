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

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";

/**
 * Takes host paths out of a text meant for a guest: project paths become relative, anything else
 * outside the project is reduced to its file name.
 */
export function scrubPaths(text: string, root: string): string {
  const inRoot = (p: string) => (p === root ? "." : p.startsWith(root + "/") ? p.slice(root.length + 1) : null);
  return text
    .replace(/file:\/\/[^\s)"'`\]>]+/g, (uri) => {
      let p = uri.slice("file://".length);
      try {
        p = decodeURIComponent(p);
      } catch {}
      return inRoot(p) ?? `…/${baseName(p)}`;
    })
    .split(root + "/").join("")
    .replace(/(^|[\s"'`(=\[<,:])((?:[A-Za-z]:[\\/]|~[\\/]|\/)(?:[^\s"'`()<>,:;[\]\\/]+[\\/])+[^\s"'`()<>,:;[\]\\/]*)/g, (_m, pre: string, p: string) => `${pre}…/${baseName(p)}`);
}

const isCoord = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= LSP_LIMITS.coordinate;
const isPos = (p: any): p is WirePos => isCoord(p?.line) && isCoord(p?.character);
export const isRange = (r: any): r is WireRange => isPos(r?.start) && isPos(r?.end);

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A server diagnostic as guests get it: only what the editor shows, with no host paths. */
export function wireDiagnostic(d: any, root: string): WireDiagnostic | null {
  if (!isRange(d?.range) || typeof d.message !== "string") return null;
  const { start, end } = d.range;
  return {
    range: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } },
    ...(Number.isInteger(d.severity) ? { severity: d.severity } : {}),
    message: cut(scrubPaths(d.message, root), LSP_LIMITS.message),
    ...(typeof d.source === "string" ? { source: cut(scrubPaths(d.source, root), LSP_LIMITS.source) } : {}),
  };
}

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
  Number.isSafeInteger(e?.rev) && typeof e.hash === "string" && Number.isSafeInteger(e.len) && Array.isArray(e.diagnostics) && e.diagnostics.every(isWireDiagnostic) && isFeatures(e.features);

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
}
export interface WireFix {
  title: string;
  edits: WireEdit[];
}

/** Docs (a string, MarkedString, MarkupContent or a list of them) with no host paths and a size cap. */
export function wireMarkup(c: any, root: string): unknown {
  const text = (s: string) => cut(scrubPaths(s, root), LSP_LIMITS.doc);
  if (typeof c === "string") return text(c);
  if (Array.isArray(c)) return c.slice(0, 20).map((x) => wireMarkup(x, root)).filter((x) => x !== undefined);
  if (typeof c?.value !== "string") return undefined;
  if (c.kind === "markdown" || c.kind === "plaintext") return { kind: c.kind, value: text(c.value) };
  return { language: typeof c.language === "string" ? c.language.slice(0, 40) : "", value: text(c.value) };
}

/**
 * Edits as guests may apply them, or null if any is malformed or would write a host path into the
 * shared text. Text is not scrubbed here: changing code would corrupt it, so it's refused instead.
 */
export function wireEdits(list: unknown, root: string): WireEdit[] | null {
  if (!Array.isArray(list) || list.length > LSP_LIMITS.edits) return null;
  const out: WireEdit[] = [];
  for (const e of list) {
    if (!isRange(e?.range) || typeof e.newText !== "string" || e.newText.includes(root)) return null;
    const { start, end } = e.range;
    out.push({ range: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } }, newText: e.newText });
  }
  return out;
}

/** A completion item for guests, or null if it can't be offered without exposing a host path. */
export function wireItem(item: any, id: number, root: string): WireItem | null {
  if (typeof item?.label !== "string") return null;
  const short = (s: unknown, n = LSP_LIMITS.label) => (typeof s === "string" ? cut(scrubPaths(s, root), n) : undefined);
  const out: WireItem = { id, label: short(item.label)! };
  // These filter and sort: they stay as the server wrote them, unless they hold the project path.
  for (const k of ["filterText", "sortText"] as const) if (typeof item[k] === "string" && item[k].length <= LSP_LIMITS.label && !item[k].includes(root)) out[k] = item[k];
  if (typeof item.detail === "string") out.detail = short(item.detail, LSP_LIMITS.message);
  if (typeof item.labelDetails?.detail === "string") out.labelDetails = { detail: short(item.labelDetails.detail) };
  if (Number.isInteger(item.kind)) out.kind = item.kind;
  if (item.documentation !== undefined) out.documentation = wireMarkup(item.documentation, root);
  if (typeof item.insertText === "string") {
    if (item.insertText.includes(root)) return null;
    out.insertText = item.insertText;
  }
  if (item.insertTextFormat === 1 || item.insertTextFormat === 2) out.insertTextFormat = item.insertTextFormat;
  if (item.textEdit) {
    const range = item.textEdit.range ?? item.textEdit.insert;
    const edits = wireEdits([{ range, newText: item.textEdit.newText }], root);
    if (!edits) return null;
    out.textEdit = edits[0];
  }
  if (item.additionalTextEdits) {
    const edits = wireEdits(item.additionalTextEdits, root);
    if (!edits) return null;
    out.additionalTextEdits = edits;
  }
  return out;
}
