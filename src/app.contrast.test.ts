import { describe, expect, test } from "vitest";

// Vitest stubs every .css import (even ?raw) to "", so read the file through Node (no @types/node here).
type Fs = { readFileSync(path: string, enc: "utf8"): string };
const proc = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const css = (proc.getBuiltinModule("node:fs") as Fs).readFileSync(`${proc.cwd()}/src/app.css`, "utf8");

// #34: white text on the light accent had a contrast of 2.84:1 (WCAG AA needs 4.5:1).
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastWithWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);

describe("primary button colours", () => {
  test("every --accent-fill keeps white text at >= 4.5:1", () => {
    const fills = [...css.matchAll(/--accent-fill:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThanOrEqual(2);
    for (const f of fills) expect(contrastWithWhite(f), f).toBeGreaterThanOrEqual(4.5);
  });

  test("filled primary buttons use --accent-fill", () => {
    expect(css).toMatch(/\.btn\.primary \{ background: var\(--accent-fill\); color: white; \}/);
  });
});
