import { afterEach, describe, expect, test } from "vitest";
import { allSheets, sheetIdFor } from "./help";
import { codeSheets } from "./help-code";
import { setLocale, type Locale } from "./i18n/index.svelte";

afterEach(() => setLocale("en"));

describe("cheat sheets", () => {
  test.each(["en", "de", "fr"] as Locale[])("%s: unique ids, every sheet filled, no empty cells", (l) => {
    setLocale(l);
    const sheets = allSheets();
    const ids = sheets.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["shortcuts", "markdown", "latex", ...Object.keys(codeSheets)]));
    for (const { id, label, sheet } of sheets) {
      expect(label, id).toBeTruthy();
      if (id === "shortcuts") continue; // generated from the command registry
      expect(sheet.sections.length, id).toBeGreaterThan(0);
      for (const sec of sheet.sections) {
        expect(sec.title, id).toBeTruthy();
        expect(sec.rows.length, `${id} / ${sec.title}`).toBeGreaterThan(0);
        for (const row of sec.rows) {
          expect(row.length).toBe(2);
          expect(row[0]?.trim(), `${id} / ${sec.title}: ${row}`).toBeTruthy();
          expect(row[1]?.trim(), `${id} / ${sec.title}: ${row}`).toBeTruthy();
        }
      }
    }
  });

  test("raw rows are [code, desc] or [code, en, de, fr], triples complete", () => {
    for (const [id, s] of Object.entries(codeSheets))
      for (const sec of s.sections) {
        if (Array.isArray(sec.title)) expect(sec.title.length, id).toBe(3);
        for (const r of sec.rows) {
          expect([2, 4], `${id}: ${r}`).toContain(r.length);
          if (Array.isArray(r[0])) expect(r[0].length, `${id}: ${r}`).toBe(3);
        }
      }
  });

  test("key names in code columns follow the language", () => {
    const row = (l: Locale) => {
      setLocale(l);
      return allSheets().find((s) => s.id === "python")!.sheet.sections.flatMap((s) => s.rows).find((r) => r[1] && /Ctrl|Strg/.test(r[0]) && /Space|Leertaste|Espace/.test(r[0]))!;
    };
    expect(row("en")[0]).toBe("Ctrl Space");
    expect(row("de")[0]).toBe("Strg Leertaste");
    expect(row("fr")[0]).toBe("Ctrl Espace");
  });

  test("sheetIdFor", () => {
    expect(sheetIdFor("code", "rust")).toBe("rust");
    expect(sheetIdFor("code", "json")).toBe("python");
    expect(sheetIdFor("code", null)).toBe("python");
    expect(sheetIdFor("text", null)).toBe("shortcuts");
    expect(sheetIdFor("markdown", null)).toBe("markdown");
    expect(sheetIdFor("latex", "rust")).toBe("latex");
  });
});
