/**
 * The language the user chose for a file in Code mode, independent of its extension. Stored per
 * file and only on this machine: nothing goes into the file or the project. Shared files of a
 * Code Together guest (`collab:`) never have one, so a guest can't set the host's.
 */
import { langById, langFor, type LangId, type LangInfo } from "./languages";

const KEY = "code.languageOverrides";

function load(text: string | null) {
  const out = new Map<string, LangId>();
  try {
    for (const [path, id] of Object.entries(JSON.parse(text ?? "{}"))) if (typeof id === "string" && langById(id)) out.set(path, id as LangId);
  } catch {
    // Unreadable: every file is back on its default.
  }
  return out;
}

function read() {
  try {
    return load(localStorage.getItem(KEY));
  } catch {
    return new Map<string, LangId>();
  }
}

let overrides = read();
/** Bumped on every change, so derived values and effects that read an override follow it. */
const rev = $state({ n: 0 });
const listeners = new Set<(path: string) => void>();

function store() {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(overrides)));
  } catch {
    // Storage is off: the choice holds until the app closes.
  }
}

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

// Another window of this Omega changed a choice.
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    const next = load(e.newValue);
    const changed = [...new Set([...overrides.keys(), ...next.keys()])].filter((p) => overrides.get(p) !== next.get(p));
    overrides = next;
    rev.n++;
    for (const path of changed) for (const l of listeners) l(path);
  });

/** Called with the path whose language changed. */
export function onLanguageOverride(fn: (path: string) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function overrideFor(path: string | null | undefined): LangId | null {
  void rev.n;
  return (path && overrides.get(path)) || null;
}

/** Sets the file's language; null is "Automatic". False for a path that can't have one. */
export function setLanguageOverride(path: string | null | undefined, id: LangId | null): boolean {
  if (!path || path.startsWith("collab:") || (id && !langById(id))) return false;
  if ((overrides.get(path) ?? null) === id) return true;
  if (id) overrides.set(path, id);
  else overrides.delete(path);
  store();
  rev.n++;
  for (const l of listeners) l(path);
  return true;
}

/** A file or folder was renamed, moved (`to`) or deleted (null). What lands on `to` loses its old choice. */
export function moveLanguageOverrides(from: string, to: string | null) {
  const moved = [...overrides].filter(([p]) => within(p, from));
  const replaced = to === null ? [] : [...overrides.keys()].filter((p) => within(p, to) && !within(p, from));
  if (!moved.length && !replaced.length) return;
  for (const p of replaced) overrides.delete(p);
  for (const [p] of moved) overrides.delete(p);
  if (to !== null) for (const [p, id] of moved) overrides.set(to + p.slice(from.length), id);
  store();
  rev.n++;
}

/** The language a file is treated as: the user's choice, else the one of its extension. */
export function effectiveLang(path: string | null | undefined): LangInfo | null {
  const natural = langFor(path ?? null);
  const id = overrideFor(path);
  // The same language keeps the extension's variant (TSX, an OCaml interface).
  return !id || natural?.id === id ? natural : langById(id);
}

/** The file is set to a language its extension doesn't stand for. */
export function isForeignLang(path: string | null | undefined): boolean {
  const id = overrideFor(path);
  return !!id && langFor(path ?? null)?.id !== id;
}
