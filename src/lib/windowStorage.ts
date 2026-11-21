// localStorage with several windows. Windows share one store, so what belongs to a single window
// (its folder, mode, layout, session) is kept under `w:<label>:<key>`; every other key is a global
// setting. Call sites keep using `localStorage`: `installWindowStorage` scopes it before any module
// reads it (see `windowBoot.ts`).

const WINDOW_KEYS = new Set([
  "root",
  "mode",
  "layout",
  "session",
  "sidebarWidth",
  "termHeight",
  "termVisible",
  "termSplit",
  "expanded",
  "debugSections",
  "watches",
  "pdfZoom",
  "collab.guestSnapshot",
  "find.query",
  "find.case",
  "find.word",
  "find.regex",
  "find.mask",
  "find.pin",
]);
const WINDOW_PREFIXES = ["termVisible:"];

/** Set once the keys of a single-window profile have moved into its first window. */
export const MIGRATED_KEY = "windows.migrated";
const PREFIX = "w:";

export const isWindowKey = (key: string) => WINDOW_KEYS.has(key) || WINDOW_PREFIXES.some((p) => key.startsWith(p));
const scopedKey = (label: string, key: string) => `${PREFIX}${label}:${key}`;

const keysOf = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i)).filter((k): k is string => k !== null);

/**
 * Moves a single-window profile's state into `label`. All or nothing: if storage fails halfway,
 * the old keys stay and the next start tries again.
 */
export function migrateToWindow(real: Storage, label: string) {
  if (real.getItem(MIGRATED_KEY)) return;
  const keys = keysOf(real).filter(isWindowKey);
  try {
    for (const k of keys) real.setItem(scopedKey(label, k), real.getItem(k)!);
    real.setItem(MIGRATED_KEY, "1");
  } catch {
    for (const k of keys) real.removeItem(scopedKey(label, k));
    return;
  }
  for (const k of keys) real.removeItem(k);
}

/** Drops the state of windows that are closed for good. */
export function pruneWindows(real: Storage, open: string[]) {
  for (const k of keysOf(real)) {
    if (!k.startsWith(PREFIX)) continue;
    const end = k.indexOf(":", PREFIX.length);
    if (end > 0 && !open.includes(k.slice(PREFIX.length, end))) real.removeItem(k);
  }
}

/** A Storage view for one window. */
export function scopedStorage(real: Storage, label: string): Storage {
  const map = (key: string) => (isWindowKey(key) ? scopedKey(label, key) : key);
  const own = `${PREFIX}${label}:`;
  // This window's keys under their plain names, plus the global ones.
  const visible = () => keysOf(real).flatMap((k) => (k.startsWith(own) ? [k.slice(own.length)] : k.startsWith(PREFIX) ? [] : [k]));
  return {
    get length() {
      return visible().length;
    },
    key: (i: number) => visible()[i] ?? null,
    getItem: (key: string) => real.getItem(map(String(key))),
    setItem: (key: string, value: string) => real.setItem(map(String(key)), value),
    removeItem: (key: string) => real.removeItem(map(String(key))),
    clear: () => {
      for (const k of visible()) real.removeItem(map(k));
    },
  };
}

/** The unscoped store (for pruning); set once installed. */
let realStorage: Storage | null = null;
export const unscopedStorage = () => realStorage ?? localStorage;

/** Replaces `localStorage` for this page. Does nothing outside Tauri. */
export function installWindowStorage(label: string | null) {
  if (!label || realStorage) return;
  const real = window.localStorage;
  migrateToWindow(real, label);
  realStorage = real;
  Object.defineProperty(window, "localStorage", { value: scopedStorage(real, label), configurable: true });
}

// ------------------------------------------------------------------ live global settings

type Handler = (value: string | null) => void;
const handlers = new Map<string, Set<Handler>>();
let listening = false;

/** Runs `fn` when another window changes one of these global keys. */
export function onGlobalChange(keys: string | string[], fn: Handler) {
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("storage", (e) => {
      if (e.key !== null) for (const h of handlers.get(e.key) ?? []) h(e.newValue);
    });
  }
  for (const k of Array.isArray(keys) ? keys : [keys]) {
    if (!handlers.has(k)) handlers.set(k, new Set());
    handlers.get(k)!.add(fn);
  }
}
