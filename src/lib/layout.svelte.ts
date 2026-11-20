/**
 * Dockable tool windows. Every view (files, terminal, PDF …) lives in one of three zones around
 * the editor – left, right, bottom – and can be moved by drag and drop or shortcut. Views in the
 * same zone are tabs. The arrangement and sizes are global; whether a zone is open is remembered
 * per mode (e.g. terminal open in Code, closed in Markdown).
 */
import { app } from "./state.svelte";
import { dbg } from "./debug/store.svelte";
import { find } from "./search/search.svelte";
import * as ed from "./editor";
import type { Mode } from "./modes";

export type ViewId = "files" | "changes" | "outline" | "terminal" | "debug" | "console" | "search" | "pdf";
export type Zone = "left" | "right" | "bottom";
export const ZONES: Zone[] = ["left", "right", "bottom"];
export const VIEWS: ViewId[] = ["files", "changes", "outline", "terminal", "debug", "console", "search", "pdf"];
export const MIN_SIZE: Record<Zone, number> = { left: 210, right: 260, bottom: 120 };
/** Narrowest editor column next to docked side zones; below that the side zones float over it. */
export const CENTER_MIN = 340;
const GAP = 8;

interface ZoneState {
  views: ViewId[];
  active: ViewId | null;
  size: number;
}
type OpenState = Partial<Record<Mode, Partial<Record<Zone, boolean>>>>;

const DEFAULT_ZONES: Record<Zone, ZoneState> = {
  left: { views: ["files", "changes", "outline"], active: "files", size: 250 },
  right: { views: ["debug", "pdf"], active: null, size: 560 },
  bottom: { views: ["terminal", "console", "search"], active: "terminal", size: 260 },
};
const defaultZone = (v: ViewId): Zone => ZONES.find((z) => DEFAULT_ZONES[z].views.includes(v))!;

function num(key: string): number | null {
  const n = Number(localStorage.getItem(key));
  return n > 0 ? n : null;
}

/** Reads the saved layout from localStorage, dropping unknown / duplicate views (exported for tests). */
export function load(): { zones: Record<Zone, ZoneState>; open: OpenState } {
  let saved: { zones?: Record<Zone, Partial<ZoneState>>; open?: OpenState } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem("layout") || "null");
  } catch {}
  const zones = structuredClone(DEFAULT_ZONES);
  if (saved?.zones) {
    const seen = new Set<ViewId>();
    const missing: Zone[] = [];
    for (const z of ZONES) {
      const s = saved.zones[z];
      if (!s || typeof s !== "object") {
        missing.push(z);
        continue;
      }
      zones[z].views = [];
      for (const v of Array.isArray(s.views) ? s.views : []) {
        if (VIEWS.includes(v) && !seen.has(v)) {
          seen.add(v);
          zones[z].views.push(v);
        }
      }
      zones[z].active = s.active && zones[z].views.includes(s.active) ? s.active : null;
      if (typeof s.size === "number" && s.size > 0) zones[z].size = s.size;
    }
    // A zone missing from the saved data keeps its defaults, minus views placed elsewhere.
    for (const z of missing) {
      zones[z].views = zones[z].views.filter((v) => !seen.has(v));
      if (zones[z].active && !zones[z].views.includes(zones[z].active)) zones[z].active = null;
      for (const v of zones[z].views) seen.add(v);
    }
    // Views added in a later version go to their default zone.
    for (const v of VIEWS) if (!seen.has(v)) zones[defaultZone(v)].views.push(v);
  } else {
    // Sizes of the panels before dockable layout.
    zones.left.size = num("sidebarWidth") ?? 250;
    zones.right.size = num("pdfWidth") ?? 560;
    zones.bottom.size = num("termHeight") ?? 260;
  }
  return { zones, open: sanitizeOpen(saved?.open) };
}

/** Keeps only `{ <mode>: { <zone>: boolean } }` entries of saved open state; anything else is dropped. */
function sanitizeOpen(raw: unknown): OpenState {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const out: Record<string, Partial<Record<Zone, boolean>>> = {};
  if (!isObj(raw)) return out;
  for (const [mode, zones] of Object.entries(raw)) {
    if (!isObj(zones)) continue;
    const z = Object.fromEntries(ZONES.filter((k) => typeof zones[k] === "boolean").map((k) => [k, zones[k] as boolean]));
    if (Object.keys(z).length) out[mode] = z;
  }
  return out as OpenState;
}

const initial = load();
export const layout = $state({
  zones: initial.zones,
  open: initial.open,
});

/** Window size in CSS px (decides whether side zones are docked or float as overlays). */
export const viewport = $state({ w: innerWidth, h: innerHeight });
addEventListener("resize", () => {
  viewport.w = innerWidth;
  viewport.h = innerHeight;
});

/** Side zones opened as overlay in a narrow window. Not persisted: overlays start closed. */
const peek = $state<Record<Zone, boolean>>({ left: false, right: false, bottom: false });

export const drag = $state({
  view: null as ViewId | null,
  x: 0,
  y: 0,
  target: null as DropTarget | null,
});

export interface DropTarget {
  zone: Zone;
  index: number;
  /** Where the zone would appear (overlay highlight). */
  preview: { x: number; y: number; w: number; h: number };
  /** Insertion marker inside a tab strip. */
  line?: { x: number; y: number; h: number };
}

function save() {
  try {
    localStorage.setItem("layout", JSON.stringify({ zones: layout.zones, open: layout.open }));
  } catch {}
}

// ------------------------------------------------------------------ queries

/** Views that make sense right now (PDF only in LaTeX, debugger only while debugging …). */
export function available(v: ViewId): boolean {
  switch (v) {
    case "outline":
      return app.mode === "latex";
    case "pdf":
      return app.mode === "latex" && !!app.activeId;
    case "debug":
      return app.mode === "code" && dbg.status !== "idle";
    case "console":
      return dbg.status !== "idle" || dbg.console.length > 0;
    case "search":
      return !!find.docked;
    default:
      return true;
  }
}

export const zoneOf = (v: ViewId): Zone => ZONES.find((z) => layout.zones[z].views.includes(v)) ?? defaultZone(v);
export const visibleViews = (z: Zone): ViewId[] => layout.zones[z].views.filter(available);

export function activeView(z: Zone): ViewId | null {
  const vis = visibleViews(z);
  const a = layout.zones[z].active;
  return a && vis.includes(a) ? a : (vis[0] ?? null);
}

function defaultOpen(z: Zone, mode: Mode): boolean {
  if (z !== "bottom") return true;
  // Terminal visibility from before the dockable layout (per mode since then, Code only before).
  const v = localStorage.getItem(`termVisible:${mode}`);
  if (v !== null) return v === "true";
  return mode === "code" && localStorage.getItem("termVisible") !== "false";
}

export const isOpen = (z: Zone): boolean => layout.open[app.mode]?.[z] ?? defaultOpen(z, app.mode);

/** Whether a side zone fits next to the editor column (else it floats over the editor). */
export function isOverlay(z: Zone): boolean {
  if (z === "bottom") return false;
  const base = 2 * GAP + CENTER_MIN + GAP; // shell padding + editor + gap to the zone
  const leftFits = viewport.w >= base + MIN_SIZE.left;
  if (z === "left") return !leftFits;
  const leftDocked = leftFits && isOpen("left") && activeView("left") !== null;
  return viewport.w < base + MIN_SIZE.right + (leftDocked ? MIN_SIZE.left + GAP : 0);
}

export const zoneShown = (z: Zone): boolean => activeView(z) !== null && (isOverlay(z) ? peek[z] : isOpen(z));
export const isShown = (v: ViewId): boolean => zoneShown(zoneOf(v)) && activeView(zoneOf(v)) === v;

// ------------------------------------------------------------------ actions

export function setOpen(z: Zone, open: boolean) {
  // Overlays: one at a time. The open state is saved too, for when the window gets wider again
  // (clicking next to an overlay only closes it via closeOverlays and keeps that state).
  if (isOverlay(z)) {
    peek[z] = open;
    if (open) for (const o of ZONES) if (o !== z) peek[o] = false;
  }
  (layout.open[app.mode] ??= {})[z] = open;
  save();
}

/** Closes floating side zones (click into the editor, file opened …). */
export function closeOverlays() {
  peek.left = peek.right = false;
}

export function setActive(z: Zone, v: ViewId) {
  layout.zones[z].active = v;
  save();
}

export function setSize(z: Zone, size: number) {
  layout.zones[z].size = Math.round(size);
}
export const saveLayout = save;

/** Makes a view the visible tab of its zone and opens the zone. */
export function showView(v: ViewId) {
  const z = zoneOf(v);
  layout.zones[z].active = v;
  setOpen(z, true);
}

/** Closes the view's zone if the view is what it currently shows. */
export function hideView(v: ViewId) {
  if (isShown(v)) setOpen(zoneOf(v), false);
}

/** Buttons: show ↔ hide. */
export function toggleView(v: ViewId) {
  if (isShown(v)) hideView(v);
  else showView(v);
}

export function toggleZone(z: Zone) {
  setOpen(z, !zoneShown(z));
}

/** Focus callbacks for views that need more than "focus the first control" (terminal). */
const focusers = new Map<ViewId, () => void>();
export function registerFocus(v: ViewId, fn: () => void) {
  focusers.set(v, fn);
}

function viewEl(v: ViewId) {
  return document.querySelector<HTMLElement>(`[data-view="${v}"]`);
}

export function focusView(v: ViewId) {
  if (!available(v)) return;
  showView(v);
  requestAnimationFrame(() => {
    const f = focusers.get(v);
    if (f) return f();
    const el = viewEl(v);
    const target = el?.querySelector<HTMLElement>("input, textarea, [role=tree], button, [tabindex]") ?? el;
    target?.focus();
  });
}

/** Shortcuts (JetBrains style): focus the view, or hide it if it already has focus. */
export function toggleFocus(v: ViewId) {
  if (isShown(v) && focusedView() === v) {
    hideView(v);
    ed.focus();
  } else focusView(v);
}

let lastFocused: ViewId | null = null;
/** focusin handler of the zones: remembers the last focused view (for move shortcuts). */
export function noteFocus(e: FocusEvent) {
  const v = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-view]")?.dataset.view as ViewId | undefined;
  if (v) lastFocused = v;
}

export function focusedView(): ViewId | null {
  return ((document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-view]")?.dataset.view as ViewId | undefined) ?? null;
}

export function moveView(v: ViewId, z: Zone, index?: number) {
  const from = zoneOf(v);
  const src = layout.zones[from];
  const i = src.views.indexOf(v);
  if (i >= 0) src.views.splice(i, 1);
  if (src.active === v) src.active = src.views.find(available) ?? src.views[0] ?? null;
  const dst = layout.zones[z];
  let at = index ?? dst.views.length;
  if (from === z && i >= 0 && i < at) at--;
  dst.views.splice(Math.max(0, Math.min(at, dst.views.length)), 0, v);
  dst.active = v;
  setOpen(z, true);
}

/** Shortcut: moves the focused (or last focused) view to another zone and keeps it focused. */
export function moveFocused(z: Zone) {
  const v = focusedView() ?? lastFocused;
  if (!v || !available(v)) return;
  moveView(v, z);
  setTimeout(() => focusView(v), 50);
}

export function resetLayout() {
  layout.zones = structuredClone(DEFAULT_ZONES);
  layout.open = {};
  save();
}

// ------------------------------------------------------------------ drag and drop

function inside(r: DOMRect, x: number, y: number, pad = 0) {
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

function hitTest(x: number, y: number): DropTarget | null {
  // 1. Exactly onto a tab strip: insert at that position.
  for (const strip of document.querySelectorAll<HTMLElement>("[data-drop-zone]")) {
    if (!strip.offsetParent) continue;
    const r = strip.getBoundingClientRect();
    if (!inside(r, x, y, 6)) continue;
    const zone = strip.dataset.dropZone as Zone;
    const tabs = [...strip.querySelectorAll<HTMLElement>("[data-view-tab]")];
    let index = 0;
    for (const t of tabs) {
      const tr = t.getBoundingClientRect();
      if (x > tr.left + tr.width / 2) index++;
    }
    const tabsAll = layout.zones[zone].views;
    // Index among visible tabs → index in the zone's full list.
    const visible = tabs.map((t) => t.dataset.viewTab as ViewId);
    const fullIndex = index < visible.length ? tabsAll.indexOf(visible[index]) : tabsAll.length;
    const ref = tabs[Math.min(index, tabs.length - 1)]?.getBoundingClientRect();
    const lx = !ref ? r.left + 8 : index < tabs.length ? ref.left - 2 : ref.right + 2;
    const zr = strip.closest<HTMLElement>("[data-zone]")!.getBoundingClientRect();
    return { zone, index: fullIndex, preview: { x: zr.left, y: zr.top, w: zr.width, h: zr.height }, line: { x: lx, y: r.top + 3, h: r.height - 6 } };
  }
  // 2. Near an edge of the work area: dock into that zone (appended).
  const main = document.querySelector<HTMLElement>(".main")?.getBoundingClientRect();
  const center = document.querySelector<HTMLElement>(".center")?.getBoundingClientRect();
  if (!main || !center || !inside(main, x, y)) return null;
  const edge = Math.min(main.width * 0.22, 260);
  let zone: Zone | null = null;
  if (x < main.left + edge) zone = "left";
  else if (x > main.right - edge) zone = "right";
  else if (y > center.bottom - Math.min(center.height * 0.3, 240)) zone = "bottom";
  if (!zone) return null;
  const el = document.querySelector<HTMLElement>(`[data-zone="${zone}"]`);
  let preview: DropTarget["preview"];
  if (zoneShown(zone) && el?.offsetParent) {
    const r = el.getBoundingClientRect();
    preview = { x: r.left, y: r.top, w: r.width, h: r.height };
  } else {
    const s = layout.zones[zone].size;
    if (zone === "left") preview = { x: main.left, y: main.top, w: Math.min(s, main.width / 2), h: main.height };
    else if (zone === "right") preview = { x: main.right - Math.min(s, main.width / 2), y: main.top, w: Math.min(s, main.width / 2), h: main.height };
    else preview = { x: center.left, y: center.bottom - Math.min(s, center.height / 2), w: center.width, h: Math.min(s, center.height / 2) };
  }
  return { zone, index: layout.zones[zone].views.length, preview };
}

/** pointerdown on a view tab: becomes a drag once the pointer moved a few pixels. */
export function startDrag(e: PointerEvent, v: ViewId) {
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      started = true;
      drag.view = v;
      document.body.classList.add("dock-dragging");
    }
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    drag.target = hitTest(ev.clientX, ev.clientY);
  };
  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    if (!started) return;
    const t = drag.target;
    drag.view = null;
    drag.target = null;
    document.body.classList.remove("dock-dragging");
    // The pointerup must not also count as a click on whatever is under the pointer.
    const swallow = (ce: MouseEvent) => {
      ce.stopPropagation();
      ce.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (drop && t) moveView(v, t.zone, t.index);
  };
  const up = () => finish(true);
  const key = (ke: KeyboardEvent) => {
    if (ke.key !== "Escape") return;
    ke.preventDefault();
    ke.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}
