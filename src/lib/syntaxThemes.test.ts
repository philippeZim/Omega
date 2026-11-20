import { describe, expect, test } from "vitest";
import { SYNTAX_THEMES, themeById, themeVars } from "./syntaxThemes";

const HEX = /^#[0-9a-f]{6}$/i;
const COLOR = /^(#[0-9a-f]{6}|rgba\(\d{1,3},\d{1,3},\d{1,3},(0|1|0?\.\d+)\))$/i;
const KEYS = ["plain", "keyword", "string", "number", "comment", "type", "function", "definition", "property", "preproc", "operator", "invalid"];

describe("syntax themes", () => {
  test("ids and names are unique", () => {
    const ids = SYNTAX_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(SYNTAX_THEMES.map((t) => t.name)).size).toBe(ids.length);
  });

  test("there are dark and light themes", () => {
    expect(SYNTAX_THEMES.some((t) => t.light)).toBe(true);
    expect(SYNTAX_THEMES.some((t) => !t.light)).toBe(true);
    expect(SYNTAX_THEMES[0].light).toBeFalsy(); // fallback is a dark theme
  });

  test.each(SYNTAX_THEMES.map((t) => [t.id, t] as const))("%s: complete, valid colours and 16 ANSI hex colours", (_, t) => {
    expect(Object.keys(t.colors).sort()).toEqual([...KEYS].sort());
    for (const [k, v] of Object.entries(t.colors)) expect(v, k).toMatch(COLOR);
    expect(t.ansi).toHaveLength(16);
    for (const c of t.ansi) expect(c).toMatch(HEX);
    expect(["classic", "modern", "retro"]).toContain(t.group);
  });

  test("themeById falls back to the first theme", () => {
    expect(themeById("dracula").id).toBe("dracula");
    expect(themeById("nope")).toBe(SYNTAX_THEMES[0]);
  });

  test("themeVars emits one custom property per colour", () => {
    const v = themeVars(themeById("onedark"));
    expect(v).toContain("--syn-keyword: #c678dd;");
    expect(v.match(/--syn-/g)).toHaveLength(KEYS.length);
  });
});
