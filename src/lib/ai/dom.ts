/**
 * DOM helpers of the control MCP: finding the elements an agent means (by label or selector),
 * limited to what a user could actually reach, and key codes for synthetic key events.
 */

export const INTERACTIVE = "button, a, input, textarea, select, [role=button], [role=tab], [role=menuitem], [role=treeitem], [role=switch], [role=checkbox], [contenteditable=true], .row, .item, .hit, .chip, .tab";

export function visible(el: Element) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
}

/** All names an element goes by. Tooltip.svelte moves `title` into `data-tip` on hover, so
 *  `data-tip` can be stale after a language switch: the live `title` wins. */
export function labelsOf(el: Element): string[] {
  const h = el as HTMLElement;
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  return [h.getAttribute("aria-label"), h.getAttribute("title"), h.dataset.tip, (h as HTMLInputElement).placeholder, h.innerText || h.textContent]
    .map(norm)
    .filter(Boolean);
}

export function labelOf(el: Element): string {
  return labelsOf(el)[0] ?? "";
}

function scrollParent(el: Element): Element | null {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const st = getComputedStyle(e);
    if (/(auto|scroll)/.test(st.overflowX + st.overflowY)) return e;
  }
  return null;
}

/**
 * Could a user click `el` right now? True unless the point at its centre belongs to something
 * else on top (a modal and its backdrop, another panel). Whatever is really on top wins, so
 * non-modal panels, toasts and context menus need no special cases. Elements outside the
 * window or scrolled away inside a container count as reachable (clicking scrolls them in).
 */
export function reachable(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return true;
  const sp = scrollParent(el);
  if (sp) {
    const s = sp.getBoundingClientRect();
    if (x < s.left || x > s.right || y < s.top || y > s.bottom) return true;
  }
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return true;
  return !!hit.closest(".tip"); // tooltips don't take clicks
}

/** Finds elements by visible text / aria-label / tooltip (case-insensitive) or CSS selector.
 *  Only reachable ones unless `all` (screenshots, waiting for something to appear). */
export function findElements(opts: { text?: string; selector?: string; exact?: boolean; all?: boolean }): HTMLElement[] {
  let els: HTMLElement[];
  if (opts.selector) els = [...document.querySelectorAll<HTMLElement>(opts.selector)];
  else els = [...document.querySelectorAll<HTMLElement>(INTERACTIVE)];
  els = els.filter(visible);
  if (!opts.all) els = els.filter(reachable);
  if (opts.text) {
    const q = opts.text.toLowerCase().trim();
    const exactHit = (el: HTMLElement) => labelsOf(el).some((l) => l.toLowerCase() === q);
    const match = (el: HTMLElement) => (opts.exact ? exactHit(el) : labelsOf(el).some((l) => l.toLowerCase().includes(q)));
    els = els.filter(match);
    // Prefer the innermost matching element (a button inside a matching row, not the row).
    els = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
    // Exact matches first.
    els.sort((a, b) => Number(exactHit(b)) - Number(exactHit(a)));
  }
  return els;
}

/** `code` for punctuation keys. US positions, except `^`, which has no key of its own there:
 *  Backquote is its key on a German layout (where Omega's Ctrl+^ terminal shortcut lives). */
const PUNCT_CODES: Record<string, string> = {
  ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight",
  "\\": "Backslash", "`": "Backquote", "-": "Minus", "=": "Equal", "+": "Equal", " ": "Space", "^": "Backquote",
};

/** KeyboardEvent.code for a `key` given to press_key. */
export function keyCode(key: string): string {
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  return PUNCT_CODES[key] ?? key;
}

/** type_text goes into the document only for the editor's content, not for inputs that live
 *  inside the editor (search/replace and go-to-line panels). */
export function typesIntoEditor(focused: Element | null, editorDom: Element | null | undefined): boolean {
  if (!focused || !editorDom || !editorDom.contains(focused)) return false;
  return !(focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement);
}
