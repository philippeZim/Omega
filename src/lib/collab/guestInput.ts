/** Limits and input handling for guests typing into the host's terminals. No state or transport. */

export const TERM_LIMITS = {
  /** Characters in one input message. */
  maxInput: 4096,
  /** Characters a guest holds back while the host is still taking earlier input. */
  maxQueued: 64 * 1024,
  minCols: 2,
  maxCols: 500,
  minRows: 1,
  maxRows: 200,
  shellsPerGuest: 2,
  shellsTotal: 6,
  /** Shell output (base64) waiting for one guest; the oldest goes first when it's exceeded. */
  maxBufferedOutput: 1024 * 1024,
  /** Shell output in one message, far below the transport's limit. */
  maxOutputMessage: 256 * 1024,
};

export const validTermSize = (cols: unknown, rows: unknown) =>
  Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) >= TERM_LIMITS.minCols && (cols as number) <= TERM_LIMITS.maxCols && (rows as number) >= TERM_LIMITS.minRows && (rows as number) <= TERM_LIMITS.maxRows;

/** Cursor and editing keys, the only escape sequences a program's input needs. */
const KEY_SEQUENCES = new Set(["[A", "[B", "[C", "[D", "[H", "[F", "[3~", "OA", "OB", "OC", "OD", "OH", "OF"]);
/** Tab, line feed, carriage return, backspace, delete and Ctrl+D (end of input). */
const ALLOWED_CONTROLS = new Set([0x04, 0x08, 0x09, 0x0a, 0x0d, 0x7f]);

/** Where the escape sequence starting at `i` ends (exclusive). */
function escapeEnd(s: string, i: number) {
  const kind = s[i + 1];
  if (kind === "[") {
    let j = i + 2;
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j++;
    return Math.min(j + 1, s.length);
  }
  if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "\x07") return j + 1;
      if (s[j] === "\x1b" && s[j + 1] === "\\") return j + 2;
    }
    return s.length;
  }
  return Math.min(i + (kind === "O" ? 3 : 2), s.length);
}

/**
 * What a guest may send to a running program: text and editing keys. Signals, flow control, literal
 * next and every other escape sequence are removed, whole, so nothing a program echoes back can
 * drive the host's terminal (title, clipboard, links, status queries).
 */
export function sanitizeProgramInput(data: string): string {
  let out = "";
  for (let i = 0; i < data.length; ) {
    const code = data.charCodeAt(i);
    if (code === 0x1b) {
      const end = escapeEnd(data, i);
      const body = data.slice(i + 1, end);
      if (KEY_SEQUENCES.has(body)) out += data.slice(i, end);
      i = end;
    } else {
      // C1 controls count as escape sequences in a terminal too.
      if ((code >= 0x20 && code < 0x7f) || code > 0x9f || ALLOWED_CONTROLS.has(code)) out += data[i];
      i++;
    }
  }
  return out;
}

/** Sends typed text in order, one message at a time; what piles up meanwhile goes out together. */
export class InputPump {
  private buf = "";
  private busy = false;

  /** `deliver`: false stops and drops what's queued. */
  constructor(
    private deliver: (chunk: string) => Promise<boolean>,
    private onOverflow: () => void,
  ) {}

  push(data: string) {
    if (this.buf.length + data.length > TERM_LIMITS.maxQueued) return this.onOverflow();
    this.buf += data;
    void this.drain();
  }

  clear() {
    this.buf = "";
  }

  private take() {
    let n = Math.min(this.buf.length, TERM_LIMITS.maxInput);
    // Never between the halves of a surrogate pair.
    if (n < this.buf.length && (this.buf.charCodeAt(n - 1) & 0xfc00) === 0xd800) n--;
    const chunk = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return chunk;
  }

  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.buf) if (!(await this.deliver(this.take()))) this.buf = "";
    } finally {
      this.busy = false;
    }
  }
}
