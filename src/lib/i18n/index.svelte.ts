/**
 * UI language (English default, German, French).
 *
 * Strings live in `strings/<area>.ts`, each exporting `{ en, de, fr }` dictionaries; `de` and `fr`
 * are typed against `en`, so a missing translation is a type error. Keys are namespaced by area
 * ("settings.title"). `t()` reads the reactive `i18n.locale`, so templates and `$derived`s update
 * live when the language changes. Code that caches strings at module load (command lists, CodeMirror
 * config) must call `t()` lazily (getter / at render time) or react to `onLocaleChange`.
 */
import { dictionaries } from "./strings";

export type Locale = "en" | "de" | "fr";
export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "de", label: "Deutsch" },
  { id: "fr", label: "Français" },
];

function initial(): Locale {
  try {
    const v = localStorage.getItem("uiLanguage");
    if (v === "en" || v === "de" || v === "fr") return v;
  } catch {}
  return "en";
}

export const i18n = $state({ locale: initial() });

const listeners = new Set<(l: Locale) => void>();
/** For non-reactive consumers (e.g. CodeMirror phrases). Returns an unsubscribe function. */
export function onLocaleChange(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLocale(l: Locale) {
  i18n.locale = l;
  try {
    localStorage.setItem("uiLanguage", l);
  } catch {}
  document.documentElement.lang = l;
  for (const fn of listeners) fn(l);
}
document.documentElement.lang = i18n.locale;

export type Key = keyof typeof dictionaries.en;

/** Translate `key`, replacing `{name}` placeholders from `params`. Falls back to English, then the key. */
export function t(key: Key, params?: Record<string, string | number>): string {
  const s = (dictionaries[i18n.locale] as Record<string, string>)[key] ?? (dictionaries.en as Record<string, string>)[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
}

/** Pick a per-locale value that is not a plain string (e.g. help sheets). */
export function pick<T>(v: Record<Locale, T>): T {
  return v[i18n.locale] ?? v.en;
}
