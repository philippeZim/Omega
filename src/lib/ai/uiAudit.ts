/**
 * `ui_audit` for the control MCP: measures visual defects in the live DOM so AI testers report
 * objective findings instead of "looks odd" — clipped/overflowing text, controls outside the
 * window or covered by other elements, low text contrast, icon buttons without a label and
 * untranslated UI text.
 */
import { dictionaries } from "../i18n/strings";
import { i18n, type Locale } from "../i18n/index.svelte";

export type Check = "overflow" | "offscreen" | "covered" | "contrast" | "unlabeled" | "i18n";
export const CHECKS: Check[] = ["overflow", "offscreen", "covered", "contrast", "unlabeled", "i18n"];

export interface Finding {
  check: Check;
  severity: "high" | "medium" | "low";
  path: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  detail: string;
}

// Editor, terminal and PDF content are user data with their own scrolling; skip them.
const SKIP = ".cm-content, .cm-gutters, .cm-tooltip-hover, .xterm, .pdfViewer, .tip, [data-audit-skip]";
const INTERACTIVE = "button, a[href], input, textarea, select, [role=button], [role=tab], [role=menuitem], [role=treeitem], [role=switch], [role=checkbox]";

// ------------------------------------------------------------------ pure helpers (tested)

export type RGBA = [number, number, number, number];

/** Parses `rgb()/rgba()` as returned by getComputedStyle (also the space syntax). */
export function parseColor(s: string): RGBA | null {
  const m = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/);
  if (!m) return s === "transparent" ? [0, 0, 0, 0] : null;
  let a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (m[4]?.endsWith("%")) a /= 100;
  return [+m[1], +m[2], +m[3], a];
}

/** `top` composited over the opaque `bottom`. */
export function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: RGBA) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);

/** WCAG contrast ratio of two opaque colours (1–21). */
export function contrast(a: RGBA, b: RGBA): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Text that belongs to another UI language: returns that locale, or null. Only full strings
 *  of at least two words that differ between the languages count, so "OK" or "Git" never match. */
export function foreignLocale(text: string, locale: Locale, dicts: Record<Locale, Record<string, string>> = dictionaries as never): Locale | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 6 || !/\p{L}+\s+\p{L}+/u.test(t)) return null;
  const own = dicts[locale];
  for (const other of Object.keys(dicts) as Locale[]) {
    if (other === locale) continue;
    for (const [k, v] of Object.entries(dicts[other])) {
      if (v === t && own[k] !== t && !Object.values(own).includes(t)) return other;
    }
  }
  return null;
}

/** Hard-coded German in a non-German UI (not from the dictionaries, so `foreignLocale` misses it). */
export function looksGerman(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8) return false;
  const words = t.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.some((w) => STRONG.has(w))) return true;
  const hits = words.filter((w) => GERMAN.has(w)).length;
  return /[äöüß]/i.test(t) ? hits >= 1 || words.length <= 3 : hits >= 2;
}
// Words that are German beyond doubt; one is enough.
const STRONG = new Set("fehlgeschlagen ungültig konnte wurde werden nicht einstellungen speichern schließen abbrechen löschen umbenennen gefunden gestartet beendet anfrage".split(" "));
const GERMAN = new Set("der die das und nicht ist kein keine wird wurde werden mit für von beim fehlgeschlagen datei ordner öffnen speichern schließen abbrechen löschen umbenennen neu einstellungen fehler gefunden konnte nicht ungültig bitte noch läuft gestartet beendet".split(" "));

/** A raw i18n key shown instead of its text ("settings.title"). */
export const isRawKey = (text: string) => /^[a-z]+(\.[A-Za-z0-9]+)+$/.test(text.trim()) && text.trim() in dictionaries.en;

// ------------------------------------------------------------------ DOM

function shown(el: Element) {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.display !== "none" && !(parseFloat(st.opacity) <= 0.05) && !el.closest("[inert], [aria-hidden=true]");
}

/** Short, readable CSS path (up to 4 levels). */
function pathOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
    let p = e.tagName.toLowerCase();
    if (e.id) {
      parts.unshift(`${p}#${e.id}`);
      break;
    }
    const cls = [...e.classList].filter((c) => !/^svelte-/.test(c)).slice(0, 2);
    if (cls.length) p += "." + cls.join(".");
    parts.unshift(p);
  }
  return parts.join(" > ");
}

const ownText = (el: Element) =>
  [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").replace(/\s+/g, " ").trim();

const rectOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
};

/**
 * Tooltip text. Tooltip.svelte moves `title` to `data-tip` on hover; when Svelte later re-sets
 * `title` (e.g. after a language switch) the new title is current and `data-tip` is stale.
 */
export const tooltipOf = (el: Element) => el.getAttribute("title") || (el as HTMLElement).dataset?.tip || "";

const label = (el: Element) => {
  const h = el as HTMLElement;
  return (h.getAttribute("aria-label") || tooltipOf(h) || (h as HTMLInputElement).placeholder || h.innerText || "").replace(/\s+/g, " ").trim();
};

/** Effective background behind `el`: semi-transparent layers composited up to the page colour. */
function backgroundOf(el: Element): RGBA {
  const layers: RGBA[] = [];
  for (let e: Element | null = el; e; e = e.parentElement) {
    const st = getComputedStyle(e);
    if (st.backgroundImage !== "none" && !st.backgroundImage.startsWith("linear-gradient")) return [0, 0, 0, -1]; // image: unknown
    const c = parseColor(st.backgroundColor);
    if (c && c[3] > 0) {
      layers.push(c);
      if (c[3] >= 1) break;
    }
  }
  let bg: RGBA = [3, 3, 4, 1]; // page background of the dark theme
  for (const l of layers.reverse()) bg = over(l, bg);
  return bg;
}

function scrollParent(el: Element): Element | null {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const st = getComputedStyle(e);
    if (/(auto|scroll)/.test(st.overflowX + st.overflowY)) return e;
  }
  return null;
}

/** The layer of the topmost open *modal* (aria-modal / <dialog open>, or a dialog on a backdrop
 *  that covers the window), or null. Non-modal panels with role=dialog (collab panel) don't count. */
export function modalLayer(): Element | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const covers = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width >= vw * 0.9 && r.height >= vh * 0.9;
  };
  const layers: { el: Element; z: number; i: number }[] = [];
  [...document.querySelectorAll("[role=dialog], [aria-modal=true], dialog[open]")].filter(shown).forEach((d, i) => {
    let layer: Element | null = d.matches("[aria-modal=true], dialog[open]") ? d : null;
    let z = 0;
    for (let e: Element | null = d; e; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (st.position === "fixed" || st.position === "absolute") z = Math.max(z, parseInt(st.zIndex) || 0);
      if (!layer && st.position === "fixed" && covers(e)) layer = e;
    }
    if (layer) layers.push({ el: layer, z, i });
  });
  layers.sort((a, b) => a.z - b.z || a.i - b.i);
  return layers.length ? layers[layers.length - 1].el : null;
}

export function audit(opts: { checks?: Check[]; selector?: string; minContrast?: number; limit?: number } = {}) {
  const checks = new Set(opts.checks?.length ? opts.checks : CHECKS);
  const root = opts.selector ? document.querySelector(opts.selector) : document.body;
  if (!root) throw new Error(`Selektor nicht gefunden: ${opts.selector}`);
  const minContrast = opts.minContrast ?? 4.5;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out: Finding[] = [];
  const add = (check: Check, severity: Finding["severity"], el: Element, detail: string) =>
    out.push({ check, severity, path: pathOf(el), text: label(el).slice(0, 80), rect: rectOf(el), detail });

  const all = [...root.querySelectorAll("*")].filter((el) => !el.closest(SKIP) && shown(el));
  const textEls = all.filter((el) => ownText(el).length > 0);
  const controls = all.filter((el) => el.matches(INTERACTIVE));

  if (checks.has("overflow")) {
    for (const el of textEls) {
      const h = el as HTMLElement;
      if (h.scrollWidth <= h.clientWidth + 1 || h.clientWidth === 0) continue;
      const st = getComputedStyle(h);
      if (/(auto|scroll)/.test(st.overflowX)) continue; // scrolls on purpose
      if (st.textOverflow === "ellipsis") {
        // Truncation is intended; only worth reporting when nothing shows the full text.
        if (!h.title && !h.dataset.tip && !h.closest("[title], [data-tip]")) add("overflow", "low", el, `mit … gekürzt (${h.scrollWidth}px Text in ${h.clientWidth}px), kein Tooltip mit vollem Text`);
      } else if (st.overflowX === "hidden" || st.overflowX === "clip") add("overflow", "medium", el, `Text abgeschnitten ohne … (${h.scrollWidth}px in ${h.clientWidth}px)`);
      else add("overflow", "medium", el, `Text ragt aus dem Element (${h.scrollWidth}px in ${h.clientWidth}px)`);
    }
  }

  if (checks.has("offscreen")) {
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      const outside = r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1;
      if (!outside) continue;
      const sp = scrollParent(el);
      if (sp) continue; // reachable by scrolling
      add("offscreen", r.left >= vw || r.top >= vh || r.right <= 0 || r.bottom <= 0 ? "high" : "medium", el, `außerhalb des Fensters (${vw}×${vh})`);
    }
  }

  if (checks.has("covered")) {
    // With a modal open, everything behind it is covered on purpose: only check the modal.
    const top = modalLayer();
    for (const el of controls) {
      if (top && !top.contains(el)) continue;
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
      // Hidden inside a scroll container (scrolled away) is fine.
      const sp = scrollParent(el);
      if (sp) {
        const s = sp.getBoundingClientRect();
        if (cx < s.left || cx > s.right || cy < s.top || cy > s.bottom) continue;
      }
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || el === hit || el.contains(hit) || hit.contains(el)) continue;
      if (hit.closest(".tip")) continue;
      add("covered", "high", el, `Mitte verdeckt von ${pathOf(hit)}`);
    }
  }

  if (checks.has("contrast")) {
    for (const el of textEls) {
      if ((el as HTMLElement).closest("[disabled], [aria-disabled=true], .disabled")) continue;
      const st = getComputedStyle(el);
      const fg = parseColor(st.color);
      const bg = backgroundOf(el);
      if (!fg || bg[3] < 0) continue;
      const ratio = contrast(over(fg, bg), bg);
      const size = parseFloat(st.fontSize);
      const large = size >= 24 || (size >= 18.66 && +st.fontWeight >= 700);
      const need = large ? Math.min(minContrast, 3) : minContrast;
      if (ratio < need) add("contrast", ratio < 2 ? "high" : ratio < 3 ? "medium" : "low", el, `Kontrast ${ratio.toFixed(2)}:1 < ${need}:1 (Text ${st.color} auf rgb(${bg.slice(0, 3).map(Math.round).join(",")}), ${size}px)`);
    }
  }

  if (checks.has("unlabeled")) {
    for (const el of controls) {
      if (label(el) || el.getAttribute("aria-labelledby") || el.closest("label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))) continue;
      add("unlabeled", "medium", el, "bedienbares Element ohne Text, aria-label oder Tooltip");
    }
  }

  if (checks.has("i18n")) {
    const seen = new Set<string>();
    const consider = [...textEls, ...controls];
    for (const el of consider) {
      for (const t of new Set([ownText(el), el.getAttribute("aria-label") ?? "", (el as HTMLInputElement).placeholder ?? "", tooltipOf(el)])) {
        if (!t || seen.has(t)) continue;
        if (isRawKey(t)) {
          seen.add(t);
          add("i18n", "high", el, `roher Übersetzungs-Schlüssel "${t}"`);
          continue;
        }
        const other = foreignLocale(t, i18n.locale);
        if (other) {
          seen.add(t);
          add("i18n", "medium", el, `Text ist ${other.toUpperCase()}, Oberfläche ist ${i18n.locale.toUpperCase()}: "${t}"`);
        } else if (i18n.locale !== "de" && looksGerman(t) && !el.closest(".cm-editor, .md-preview, .tree, .tabs")) {
          seen.add(t);
          add("i18n", "low", el, `sieht nach fest eingebautem deutschem Text aus (Oberfläche ${i18n.locale.toUpperCase()}): "${t}"`);
        }
      }
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = Object.fromEntries([...checks].map((c) => [c, out.filter((f) => f.check === c).length]));
  return { viewport: { w: vw, h: vh, dpr: window.devicePixelRatio }, locale: i18n.locale, counts, findings: out.slice(0, opts.limit ?? 80), truncated: Math.max(0, out.length - (opts.limit ?? 80)) };
}
