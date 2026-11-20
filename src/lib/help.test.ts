import { afterEach, describe, expect, test } from "vitest";
import { allSheets, resolveKeys, sheetIdFor, withKeys } from "./help";
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

// #87: key columns of the code sheets follow the real bindings instead of fixed strings.
describe("command shortcuts in cheat sheets", () => {
  test("resolveKeys replaces {cmd:command.id} with its label, — when unbound", () => {
    const label = (id: string) => ({ "terminal.toggle": "Strg ^", "run.run": "" })[id] ?? "";
    expect(resolveKeys("{cmd:terminal.toggle}", label)).toBe("Strg ^");
    expect(resolveKeys("{cmd:run.run} · Ctrl Click", label)).toBe("— · Ctrl Click");
    expect(resolveKeys("Ctrl Space", label)).toBe("Ctrl Space");
    // Braces in code samples are left alone.
    expect(resolveKeys('print(f"Value: {x}")', label)).toBe('print(f"Value: {x}")');
  });

  test("the code sheets' editor and debugger rows use command placeholders", () => {
    const sheet = allSheets().find((s) => s.id === "python")!.sheet;
    const rows = withKeys(sheet, (id) => `<${id}>`).sections.flatMap((s) => s.rows.map(([code]) => code));
    expect(rows).toContain("<terminal.toggle>");
    expect(rows).toContain("<run.run>");
    expect(rows).toContain("<debug.stepOver>");
    expect(rows.join("\n")).not.toMatch(/Ctrl \^|Ctrl F2|⇧ F10/);
    expect(rows).toContain('print(f"Value: {x}")');
  });
});
