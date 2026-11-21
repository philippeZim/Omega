/**
 * Host: the Run and Build output waiting to go to guests, after it was scrubbed. Bounded: when a
 * program prints faster than guests take it, the oldest output goes and guests see one marker.
 */
import { openEscape } from "./debugMirror";
import { TERM_LIMITS } from "./guestInput";

/** UTF-16 units in one queued piece: as base64 at most 128 KiB, so one always fits a message. */
export const MIRROR_PIECE_CHARS = 32 * 1024;

function toB64(text: string) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Pieces of `text` that each end between characters and outside any escape sequence. */
function pieces(text: string) {
  const out: string[] = [];
  let start = 0;
  while (text.length - start > MIRROR_PIECE_CHARS) {
    let end = start + MIRROR_PIECE_CHARS;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const open = openEscape(text.slice(start, end));
    if (open > 0) end = start + open;
    out.push(text.slice(start, end));
    start = end;
  }
  out.push(text.slice(start));
  return out;
}

export class MirrorQueue {
  private chunks: string[] = [];
  private buffered = 0;
  private skipped = false;
  /** An escape sequence still missing its end: it stays whole, so dropping can't cut it. */
  private open = "";

  get pending() {
    return this.chunks.length > 0;
  }

  /** `b64`: scrubbed output, whole characters. */
  push(b64: string) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const text = this.open + new TextDecoder().decode(bytes);
    const at = openEscape(text);
    this.open = at >= 0 ? text.slice(at) : "";
    const body = at >= 0 ? text.slice(0, at) : text;
    if (!body) return;
    for (const piece of pieces(body)) {
      const chunk = toB64(piece);
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    while (this.buffered > TERM_LIMITS.maxBufferedOutput && this.chunks.length > 1) {
      this.buffered -= this.chunks.shift()!.length;
      this.skipped = true;
    }
  }

  /** The next message; `skipped` says output is missing before its chunks. */
  take(): { t: "term.data"; chunks: string[]; skipped?: true } {
    const chunks: string[] = [];
    let size = 0;
    while (this.chunks.length && (!chunks.length || size + this.chunks[0].length <= TERM_LIMITS.maxOutputMessage)) {
      const chunk = this.chunks.shift()!;
      size += chunk.length;
      chunks.push(chunk);
    }
    this.buffered -= size;
    const skipped = this.skipped;
    this.skipped = false;
    return { t: "term.data", chunks, ...(skipped ? { skipped: true as const } : {}) };
  }

  clear() {
    this.chunks = [];
    this.buffered = 0;
    this.skipped = false;
    this.open = "";
  }
}
