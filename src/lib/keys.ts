/**
 * Key bindings use CodeMirror-style strings: "Mod-Shift-l", "Alt-ArrowUp", "F9", "Mod-Backquote".
 * Matching is layout-aware: a binding matches via the produced character (e.key) or the physical
 * key (e.code), so e.g. "Mod-/" works on a German keyboard (Ctrl+Shift+7) and "Mod-Backquote"
 * is the key left of 1 (^ on German layouts).
 */

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);

function mods(e: KeyboardEvent, withShift = true) {
  return [e.ctrlKey || e.metaKey ? "Mod" : "", e.altKey ? "Alt" : "", withShift && e.shiftKey ? "Shift" : ""].filter(Boolean);
}

function keyName(e: KeyboardEvent): string {
  const k = e.key;
  if (k === "Dead" || k === "Unidentified" || k === "Process") return e.code;
  if (k === " ") return "Space";
  if (k === "-") return "Hyphen"; // "-" is the separator in binding strings
  if (k === "+") return "Plus";
  if (k.length === 1) return k.toLowerCase();
  return k;
}

/** All binding strings this event could satisfy. */
export function candidates(e: KeyboardEvent): string[] {
  if (MODIFIER_KEYS.has(e.key)) return [];
  const out = new Set<string>();
  const name = keyName(e);
  out.add([...mods(e), name].join("-"));
  // Shifted symbols ("/" = Shift+7 on German keyboards) match bindings written without Shift.
  if (e.shiftKey && e.key.length === 1 && !/[a-z0-9]/i.test(e.key)) out.add([...mods(e, false), name].join("-"));
  // Physical key (layout independent): Backquote, BracketLeft, Digit1, KeyD …
  if (e.code) {
    out.add([...mods(e), e.code].join("-"));
    const m = /^(Key|Digit)(.)$/.exec(e.code);
    if (m) out.add([...mods(e), m[2].toLowerCase()].join("-"));
  }
  return [...out];
}

/** The canonical binding string recorded for an event (used by the shortcut editor). */
export function bindingFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const m = /^(Key|Digit)(.)$/.exec(e.code);
  const name = m ? m[2].toLowerCase() : keyName(e);
  return [...mods(e), name].join("-");
}

export function normalize(binding: string): string {
  const parts = binding.split("-");
  const key = parts.pop()!;
  const order = ["Mod", "Alt", "Shift"];
  const ms = order.filter((m) => parts.includes(m) || (m === "Mod" && (parts.includes("Ctrl") || parts.includes("Meta"))));
  return [...ms, key.length === 1 ? key.toLowerCase() : key].join("-");
}

const LABELS: Record<string, string> = {
  Mod: "Strg", Shift: "⇧", Alt: "Alt",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Enter: "Enter", Escape: "Esc", Backspace: "⌫", Delete: "Entf", Tab: "Tab", Space: "Leertaste",
  Home: "Pos1", End: "Ende", PageUp: "Bild↑", PageDown: "Bild↓",
  Backquote: "^", BracketLeft: "Ü", BracketRight: "+", Backslash: "#", Minus: "ß", Equal: "´",
  Semicolon: "Ö", Quote: "Ä", Comma: ",", Period: ".", Slash: "-", Hyphen: "-", Plus: "+",
};

/** Human readable label, e.g. "Strg ⇧ L". */
export function formatKey(binding: string): string {
  return binding
    .split("-")
    .map((p, i, arr) => (p === "" && arr[i + 1] === "" ? "-" : p))
    .filter((p) => p !== "")
    .map((p) => LABELS[p] ?? (p.length === 1 ? p.toUpperCase() : p))
    .join(" ");
}
