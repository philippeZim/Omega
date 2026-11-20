import { describe, expect, test } from "vitest";
import { contrast, foreignLocale, isRawKey, looksGerman, over, parseColor } from "./uiAudit";

describe("colours", () => {
  test("parses computed colours", () => {
    expect(parseColor("rgb(255, 0, 10)")).toEqual([255, 0, 10, 1]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 0.5]);
    expect(parseColor("rgb(1 2 3 / 40%)")).toEqual([1, 2, 3, 0.4]);
    expect(parseColor("transparent")).toEqual([0, 0, 0, 0]);
    expect(parseColor("color(srgb 1 0 0)")).toBeNull();
  });
  test("composites and measures WCAG contrast", () => {
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 0);
    expect(contrast([255, 255, 255, 1], [255, 255, 255, 1])).toBe(1);
    expect(over([255, 255, 255, 0.5], [0, 0, 0, 1])).toEqual([127.5, 127.5, 127.5, 1]);
  });
});

describe("i18n detection", () => {
  const dicts = {
    en: { a: "Open folder", b: "OK", c: "Save all files" },
    de: { a: "Ordner öffnen", b: "OK", c: "Alle Dateien speichern" },
    fr: { a: "Ouvrir le dossier", b: "OK", c: "Enregistrer tout" },
  };
  test("finds strings of another UI language", () => {
    expect(foreignLocale("Ordner öffnen", "en", dicts)).toBe("de");
    expect(foreignLocale("Open folder", "fr", dicts)).toBe("en");
    expect(foreignLocale("Open folder", "en", dicts)).toBeNull();
    expect(foreignLocale("OK", "de", dicts)).toBeNull();
  });
  test("hard-coded German", () => {
    expect(looksGerman("Debug-Anfrage fehlgeschlagen")).toBe(true);
    expect(looksGerman("Die Datei wurde nicht gefunden")).toBe(true);
    expect(looksGerman("Build failed with exit code 1")).toBe(false);
    expect(looksGerman("main.rs")).toBe(false);
  });
  test("raw keys", () => {
    expect(isRawKey("common.cancel")).toBe(true);
    expect(isRawKey("main.rs")).toBe(false);
  });
});
