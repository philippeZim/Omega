// The bounded queue of Run output on its way to guests.
import { expect, test } from "vitest";
import { MirrorQueue, MIRROR_PIECE_CHARS } from "./mirrorQueue";
import { openEscape, StreamScrubber } from "./debugMirror";
import { TERM_LIMITS } from "./guestInput";

const toB64 = (text: string) => {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const strict = new TextDecoder("utf-8", { fatal: true });
const fromB64 = (b64: string) => strict.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

function drain(q: MirrorQueue) {
  const msgs: ReturnType<MirrorQueue["take"]>[] = [];
  while (q.pending) msgs.push(q.take());
  return msgs;
}

test("a flood is bounded, each message fits, and a gap gets one marker (#154)", () => {
  const q = new MirrorQueue();
  const line = `${"x".repeat(1000)}\n`;
  for (let i = 0; i < 20_000; i++) q.push(toB64(line));
  const msgs = drain(q);
  const total = msgs.flatMap((m) => m.chunks).reduce((n, c) => n + c.length, 0);
  expect(total).toBeLessThanOrEqual(TERM_LIMITS.maxBufferedOutput);
  for (const m of msgs) expect(m.chunks.reduce((n, c) => n + c.length, 0)).toBeLessThanOrEqual(TERM_LIMITS.maxOutputMessage);
  expect(msgs.filter((m) => m.skipped).length).toBe(1);
  expect(msgs[0].skipped).toBe(true);
});

test("output that fits arrives complete and without a marker (#154)", () => {
  const q = new MirrorQueue();
  q.push(toB64("a\x1b[3"));
  q.push(toB64("1mb ä🙂\n"));
  const msgs = drain(q);
  expect(msgs.some((m) => m.skipped)).toBe(false);
  expect(msgs.flatMap((m) => m.chunks).map(fromB64).join("")).toBe("a\x1b[31mb ä🙂\n");
});

test("one huge chunk is never cut inside a character or an escape sequence (#154)", () => {
  // The repeat shifts every kind of boundary across the piece size.
  const unit = "ä🙂\x1b[38;5;196mred\x1b[0m\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ ";
  for (const pad of [0, 1, 2, 3, 5, 7, 11, 13]) {
    const text = "p".repeat(pad) + unit.repeat(Math.ceil((MIRROR_PIECE_CHARS * 3) / unit.length));
    const q = new MirrorQueue();
    q.push(toB64(text));
    const chunks = drain(q).flatMap((m) => m.chunks);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const piece = fromB64(c); // throws on a cut character
      expect(piece).not.toContain("�");
      expect(openEscape(piece)).toBe(-1);
    }
    expect(chunks.map(fromB64).join("")).toBe(text);
  }
});

test("dropping output never lets a host path through (#154)", () => {
  const scrubber = new StreamScrubber("/home/alice/proj", "/home/alice");
  const q = new MirrorQueue();
  const bytes = new TextEncoder().encode('File "/home/alice/proj/a.py" at /home/alice/b.txt \x1b[35m/home/alice/c\x1b[0m\n'.repeat(60_000));
  for (let i = 0; i < bytes.length; i += 4093) {
    const out = scrubber.push(bytes.slice(i, i + 4093));
    if (out) q.push(toB64(out));
  }
  const rest = scrubber.flush();
  if (rest) q.push(toB64(rest));
  const msgs = drain(q);
  expect(msgs.some((m) => m.skipped)).toBe(true);
  const seen = msgs.flatMap((m) => m.chunks).map(fromB64).join("");
  expect(seen).not.toContain("alice");
});
