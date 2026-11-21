// Regression tests for #3 (lone surrogates broke every save) and #4 (CRLF converted to LF).
import { describe, expect, test } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fsApi, wellFormed } from "./api";
import { detectEol, fromDisk, toDisk } from "./eol";

describe("wellFormed (#3)", () => {
  test("lone high surrogate becomes U+FFFD", () => {
    expect(wellFormed("emoji \uD83DY x")).toBe("emoji �Y x");
  });
  test("lone low surrogate becomes U+FFFD", () => {
    expect(wellFormed("a\uDE00b")).toBe("a�b");
  });
  test("reversed pair (low before high) becomes two U+FFFD", () => {
    expect(wellFormed("\uDE00\uD83D")).toBe("��");
  });
  test("surrogate at string end / start", () => {
    expect(wellFormed("x\uD83D")).toBe("x�");
    expect(wellFormed("\uDE00x")).toBe("�x");
  });
  test("split emoji from the issue: both halves replaced", () => {
    expect(wellFormed("emoji \uD83DY\uDE00 x")).toBe("emoji �Y� x");
  });
  test("valid pairs and BMP text are kept", () => {
    const s = "emoji 😀 x 𝄞 äöü € 中文";
    expect(wellFormed(s)).toBe(s);
    expect(wellFormed("😀😀")).toBe("😀😀");
    expect(wellFormed("")).toBe("");
  });
  test("high + valid pair: only the lone half replaced", () => {
    expect(wellFormed("\uD83D😀")).toBe("�😀");
  });
  test("result is always encodable (encodeURIComponent does not throw)", () => {
    for (const s of ["\uD800", "\uDFFF", "a\uDBFFb", "\uDC00𐀀"]) expect(() => encodeURIComponent(wellFormed(s))).not.toThrow();
  });
  test("fsApi.writeFile sends a well-formed payload", async () => {
    const seen: any[] = [];
    mockIPC((cmd, args) => void seen.push({ cmd, args }));
    await fsApi.writeFile("/f.txt", "a\uD83Db");
    expect(seen).toEqual([{ cmd: "write_file", args: { path: "/f.txt", content: "a�b" } }]);
  });
});

describe("line endings (#4)", () => {
  test("detectEol", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("")).toBe("\n");
    expect(detectEol("no newline")).toBe("\n");
    expect(detectEol("\r\nfirst empty")).toBe("\r\n");
    expect(detectEol("\nfirst empty")).toBe("\n");
    // mixed: the first line break wins
    expect(detectEol("a\r\nb\nc")).toBe("\r\n");
    expect(detectEol("a\nb\r\nc")).toBe("\n");
  });

  test("fromDisk normalizes CRLF and lone CR to LF", () => {
    expect(fromDisk("a\r\nb\r\n")).toBe("a\nb\n");
    expect(fromDisk("a\rb")).toBe("a\nb");
    expect(fromDisk("a\nb")).toBe("a\nb");
    expect(fromDisk("")).toBe("");
  });

  test("toDisk", () => {
    expect(toDisk("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(toDisk("a\nb\n", "\n")).toBe("a\nb\n");
    expect(toDisk("a\nb\n", undefined)).toBe("a\nb\n");
    expect(toDisk("", "\r\n")).toBe("");
  });

  test.each([
    ["CRLF", "line1\r\nline2\r\n"],
    ["LF", "line1\nline2\n"],
    ["empty", ""],
    ["no trailing newline CRLF", "a\r\nb"],
    ["single line", "abc"],
  ])("round trip %s is byte-identical", (_name, raw) => {
    expect(toDisk(fromDisk(raw), detectEol(raw))).toBe(raw);
  });

  test("mixed endings are normalized to the first one (no stray \\r\\r\\n)", () => {
    expect(toDisk(fromDisk("a\r\nb\nc"), detectEol("a\r\nb\nc"))).toBe("a\r\nb\r\nc");
    expect(toDisk(fromDisk("a\nb\r\nc"), detectEol("a\nb\r\nc"))).toBe("a\nb\nc");
  });

  test("edited CRLF text stays CRLF", () => {
    const raw = "line1\r\nline2\r\n";
    const edited = fromDisk(raw).replace("line1", "line1x") + "line3\n";
    expect(toDisk(edited, detectEol(raw))).toBe("line1x\r\nline2\r\nline3\r\n");
  });
});
