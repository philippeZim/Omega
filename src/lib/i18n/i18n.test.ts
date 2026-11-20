import { afterEach, describe, expect, test } from "vitest";
import { dictionaries } from "./strings";
import * as common from "./strings/common";
import * as help from "./strings/help";
import * as commands from "./strings/commands";
import * as app from "./strings/app";
import * as git from "./strings/git";
import * as code from "./strings/code";
import * as ai from "./strings/ai";
import * as tools from "./strings/tools";
import { i18n, onLocaleChange, pick, setLocale, t, type Key } from "./index.svelte";

const AREAS = { common, help, commands, app, git, code, ai, tools } as Record<string, Record<"en" | "de" | "fr", Record<string, string>>>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("dictionaries", () => {
  for (const [area, d] of Object.entries(AREAS)) {
    describe(area, () => {
      const en = Object.keys(d.en).sort();
      test.each(["de", "fr"] as const)("%s has the same keys as en", (loc) => {
        expect(Object.keys(d[loc]).sort()).toEqual(en);
      });
      test.each(["en", "de", "fr"] as const)("%s has no empty strings", (loc) => {
        for (const [k, v] of Object.entries(d[loc])) expect(v.trim(), `${loc} ${k}`).not.toBe("");
      });
      test.each(["de", "fr"] as const)("%s uses the same {placeholders} as en", (loc) => {
        for (const k of en) expect(placeholders(d[loc][k]), `${loc} ${k}`).toEqual(placeholders(d.en[k]));
      });
    });
  }

  test("merged dictionaries contain every area key exactly once", () => {
    const all = Object.values(AREAS).flatMap((d) => Object.keys(d.en));
    expect(new Set(all).size).toBe(all.length);
    expect(Object.keys(dictionaries.en).length).toBe(all.length);
    expect(Object.keys(dictionaries.de).length).toBe(all.length);
    expect(Object.keys(dictionaries.fr).length).toBe(all.length);
  });
});

describe("t()", () => {
  afterEach(() => setLocale("en"));

  test("returns the string for the current locale", () => {
    setLocale("en");
    expect(t("common.cancel")).toBe("Cancel");
    setLocale("de");
    expect(t("common.cancel")).toBe("Abbrechen");
    setLocale("fr");
    expect(t("common.cancel")).toBe("Annuler");
  });

  test("interpolates {placeholders}, leaves unknown ones", () => {
    expect(t("help.noMatches", { q: "foo" })).toBe('No matches for "foo".');
    expect(t("help.noMatches", {})).toBe('No matches for "{q}".');
    expect(t("help.noMatches")).toBe('No matches for "{q}".');
  });

  test("interpolates numbers and repeated tokens", () => {
    expect(t("x.{a}{a}{b}" as Key, { a: 1, b: 0 })).toBe("x.110");
  });

  test("falls back to English, then to the key", () => {
    setLocale("de");
    const de = dictionaries.de as Record<string, string>;
    const saved = de["common.ok"];
    delete de["common.ok"];
    try {
      expect(t("common.ok")).toBe("OK");
    } finally {
      de["common.ok"] = saved;
    }
    expect(t("does.not.exist" as Key)).toBe("does.not.exist");
  });

  test("setLocale persists, sets <html lang> and notifies listeners", () => {
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    setLocale("fr");
    off();
    setLocale("de");
    expect(seen).toEqual(["fr"]);
    expect(i18n.locale).toBe("de");
    expect(localStorage.getItem("uiLanguage")).toBe("de");
    expect(document.documentElement.lang).toBe("de");
  });

  test("pick() chooses the locale value, falls back to en", () => {
    setLocale("fr");
    expect(pick({ en: 1, de: 2, fr: 3 })).toBe(3);
    expect(pick({ en: 1, de: 2 } as unknown as Record<"en" | "de" | "fr", number>)).toBe(1);
  });
});
