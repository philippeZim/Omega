import { expect, test } from "vitest";
import { byteLength, formatSize } from "./largeFile";

test("formatSize", () => {
  expect(formatSize(512)).toBe("512 B");
  expect(formatSize(1536)).toBe("1.5 KB");
  expect(formatSize(8 * 1024 * 1024)).toBe("8 MB");
  expect(formatSize(1024 ** 3)).toBe("1 GB");
  expect(formatSize(15 * 1024 ** 3)).toBe("15 GB");
});

test("byteLength counts UTF-8 bytes", () => {
  expect(byteLength("aä€")).toBe(6);
});
