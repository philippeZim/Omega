/**
 * Code Together language features: what crosses the wire, and the checks on it. Pure functions, so
 * the rules about host paths and sizes can be tested on their own.
 */

export const LSP_LIMITS = {
  diagnostics: 500,
  message: 2000,
  source: 60,
  triggers: 16,
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

const isPos = (p: any): p is WirePos => Number.isSafeInteger(p?.line) && p.line >= 0 && Number.isSafeInteger(p?.character) && p.character >= 0;
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
