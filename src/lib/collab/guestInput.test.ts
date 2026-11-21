import { expect, test, vi } from "vitest";
import { InputPump, sanitizeProgramInput as clean, TERM_LIMITS, validTermSize } from "./guestInput";

test("text and editing keys reach the program", () => {
  expect(clean("Grüße 👋\r")).toBe("Grüße 👋\r");
  expect(clean("a\x7f\b\t\n\x04")).toBe("a\x7f\b\t\n\x04");
  for (const key of ["\x1b[A", "\x1b[D", "\x1bOB", "\x1b[H", "\x1b[3~"]) expect(clean(key)).toBe(key);
});

test("signals, flow control and literal-next are removed", () => {
  expect(clean("a\x03b\x1ac\x1cd\x13e\x11f\x16g\x0fh\x00i")).toBe("abcdefghi");
});

test("escape sequences are removed whole, also ones aimed at the host's terminal", () => {
  expect(clean("a\x1b]0;evil title\x07b")).toBe("ab");
  expect(clean("a\x1b]52;c;ZXZpbA==\x1b\\b")).toBe("ab");
  expect(clean("a\x1b[6nb\x1b[200~c\x1b[2Jd")).toBe("abcd");
  expect(clean("a\x1bPq secret\x1b\\b")).toBe("ab");
  expect(clean("x\x1b]8;;http://evil")).toBe("x");
  expect(clean("a\x1bcb")).toBe("ab");
});

test("C1 controls, the one-character form of escape sequences, are removed", () => {
  expect(clean("a\u009b6nb\u009d0;t\u0085")).toBe("a6nb0;t");
});

test("terminal sizes are checked", () => {
  expect(validTermSize(80, 24)).toBe(true);
  for (const [c, r] of [[0, 24], [80, 0], [501, 24], [80, 201], [80.5, 24], ["80", 24], [null, 24], [NaN, 24], [1e9, 1e9]]) expect(validTermSize(c, r)).toBe(false);
});

test("the pump keeps order, sends one message at a time and bounds what waits", async () => {
  const sent: string[] = [];
  let release: (ok: boolean) => void = () => {};
  const over = vi.fn();
  const pump = new InputPump((c) => (sent.push(c), new Promise((r) => (release = r))), over);
  pump.push("a");
  pump.push("b");
  pump.push("c");
  expect(sent).toEqual(["a"]);
  release(true);
  await vi.waitFor(() => expect(sent).toEqual(["a", "bc"]));
  pump.push("x".repeat(TERM_LIMITS.maxQueued + 1));
  expect(over).toHaveBeenCalledOnce();
  release(false);
});

test("the pump never splits a character and stops when delivery fails", async () => {
  const sent: string[] = [];
  const pump = new InputPump(async (c) => (sent.push(c), true), () => {});
  pump.push("x".repeat(TERM_LIMITS.maxInput - 1) + "👋" + "y");
  await vi.waitFor(() => expect(sent.join("").length).toBe(TERM_LIMITS.maxInput + 2));
  expect(sent.every((c) => c.length <= TERM_LIMITS.maxInput && !c.endsWith("\ud83d"))).toBe(true);

  const refused: string[] = [];
  const dead = new InputPump(async (c) => (refused.push(c), false), () => {});
  dead.push("x".repeat(TERM_LIMITS.maxInput + 5));
  await vi.waitFor(() => expect(refused.length).toBe(1));
  await new Promise((r) => setTimeout(r, 0));
  expect(refused.length).toBe(1);
});
