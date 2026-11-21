import { afterEach, describe, expect, test } from "vitest";
import { bindingFromEvent, candidates, formatKey, normalize } from "./keys";
import { setLocale } from "./i18n/index.svelte";

const ev = (key: string, code: string, m: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  new KeyboardEvent("keydown", { key, code, ...m });

describe("normalize", () => {
  test("orders modifiers Mod, Alt, Shift", () => {
    expect(normalize("Shift-Alt-Mod-x")).toBe("Mod-Alt-Shift-x");
  });
  test("Ctrl and Meta become Mod", () => {
    expect(normalize("Ctrl-s")).toBe("Mod-s");
    expect(normalize("Meta-Shift-s")).toBe("Mod-Shift-s");
  });
  test("single-character keys are lowercased, named keys kept", () => {
    expect(normalize("Mod-L")).toBe("Mod-l");
    expect(normalize("Alt-ArrowUp")).toBe("Alt-ArrowUp");
    expect(normalize("F9")).toBe("F9");
    expect(normalize("Shift-Shift")).toBe("Shift-Shift");
  });
});

describe("candidates", () => {
  test("modifier-only events give nothing", () => {
    for (const k of ["Control", "Shift", "Alt", "Meta", "AltGraph"]) expect(candidates(ev(k, "ShiftLeft", { shiftKey: true }))).toEqual([]);
  });

  test("Ctrl+D matches by character and physical key", () => {
    const c = candidates(ev("d", "KeyD", { ctrlKey: true }));
    expect(c).toContain("Mod-d");
    expect(c).toContain("Mod-KeyD");
  });

  test("Meta (Cmd) is Mod too", () => {
    expect(candidates(ev("s", "KeyS", { metaKey: true }))).toContain("Mod-s");
  });

  test("layout fallback: the physical KeyX / DigitN position", () => {
    // Russian layout: Ctrl + the key at D's position produces "в".
    expect(candidates(ev("в", "KeyD", { ctrlKey: true }))).toContain("Mod-d");
    // French AZERTY: Ctrl+& on the 1 key.
    expect(candidates(ev("&", "Digit1", { ctrlKey: true }))).toContain("Mod-1");
  });

  test("German Ctrl+Shift+7 (\"/\") matches Mod-/", () => {
    const c = candidates(ev("/", "Digit7", { ctrlKey: true, shiftKey: true }));
    expect(c).toContain("Mod-/");
    expect(c).toContain("Mod-Shift-/");
    expect(c).toContain("Mod-Shift-7");
  });

  test("Shift+letter keeps Shift", () => {
    const c = candidates(ev("L", "KeyL", { ctrlKey: true, shiftKey: true }));
    expect(c).toContain("Mod-Shift-l");
    expect(c).not.toContain("Mod-l");
  });

  test("special key names", () => {
    expect(candidates(ev(" ", "Space", { ctrlKey: true }))).toContain("Mod-Space");
    expect(candidates(ev("-", "Minus", { ctrlKey: true }))).toContain("Mod-Hyphen");
    expect(candidates(ev("+", "BracketRight", { ctrlKey: true }))).toContain("Mod-Plus");
    expect(candidates(ev("Dead", "Backquote", { ctrlKey: true }))).toContain("Mod-Backquote");
  });
});

describe("bindingFromEvent", () => {
  test("modifier-only → null", () => {
    expect(bindingFromEvent(ev("Shift", "ShiftLeft", { shiftKey: true }))).toBeNull();
  });
  test("uses the physical letter/digit, then the key name", () => {
    expect(bindingFromEvent(ev("в", "KeyD", { ctrlKey: true, shiftKey: true }))).toBe("Mod-Shift-d");
    expect(bindingFromEvent(ev("!", "Digit1", { altKey: true, shiftKey: true }))).toBe("Alt-Shift-1");
    expect(bindingFromEvent(ev("F5", "F5"))).toBe("F5");
    expect(bindingFromEvent(ev(",", "Comma", { metaKey: true }))).toBe("Mod-,");
  });
  test("result is already normalized", () => {
    const b = bindingFromEvent(ev("ArrowUp", "ArrowUp", { shiftKey: true, altKey: true, ctrlKey: true }))!;
    expect(b).toBe("Mod-Alt-Shift-ArrowUp");
    expect(normalize(b)).toBe(b);
  });
});

describe("formatKey", () => {
  afterEach(() => setLocale("en"));

  test("English labels", () => {
    setLocale("en");
    expect(formatKey("Mod-Shift-l")).toBe("Ctrl ⇧ L");
    expect(formatKey("Alt-ArrowUp")).toBe("Alt ↑");
    expect(formatKey("Mod-Backquote")).toBe("Ctrl `");
    expect(formatKey("Mod-Hyphen")).toBe("Ctrl -");
  });

  test("German labels", () => {
    setLocale("de");
    expect(formatKey("Mod-Delete")).toBe("Strg Entf");
    expect(formatKey("Mod-Backquote")).toBe("Strg ^");
  });

  test("a literal '-' key (\"Mod--\")", () => {
    expect(formatKey("Mod--")).toBe("Ctrl -");
  });
});
