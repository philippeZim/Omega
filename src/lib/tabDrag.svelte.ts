// Dragging an editor tab (#219): onto a tab bar moves it into that group, onto the edge of a group
// splits it, onto the middle of a group moves it there. Pointer based like the dock views.
import type { Side } from "./editorGroups";
import { moveTab } from "./state.svelte";

export interface TabDropTarget {
  group: string;
  /** Insert position in the group's tab bar; unset with `side` or for "into the group". */
  index?: number;
  side?: Side;
  /** Highlighted area (viewport px). */
  preview: { x: number; y: number; w: number; h: number };
  /** Insertion marker in a tab bar. */
  line?: { x: number; y: number; h: number };
}

export const tabDrag = $state({
  id: null as string | null,
  from: null as string | null,
  name: "",
  x: 0,
  y: 0,
  target: null as TabDropTarget | null,
});

/** Distance the pointer must move before a press on a tab becomes a drag. */
const THRESHOLD = 6;
/** Share of a group's width/height at its edges that splits instead of moving into it. */
const EDGE = 0.25;

/** Set right after a drop, so the click that ends the press doesn't also activate the tab. */
let justDropped = false;
export const consumeDrop = () => {
  const d = justDropped;
  justDropped = false;
  return d;
};

/** Pure: where a pointer at (`x`, `y`) inside a group's body (`r`) drops. Exported for tests. */
export function bodyTarget(r: { left: number; top: number; width: number; height: number }, x: number, y: number): { side?: Side; preview: TabDropTarget["preview"] } {
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  const full = { x: r.left, y: r.top, w: r.width, h: r.height };
  // The nearest edge wins inside the edge band.
  const d = { left: fx, right: 1 - fx, up: fy, down: 1 - fy };
  const side = (Object.keys(d) as Side[]).reduce((a, b) => (d[b] < d[a] ? b : a));
  if (d[side] > EDGE) return { preview: full };
  const half = side === "left" || side === "right" ? { w: r.width / 2, h: r.height } : { w: r.width, h: r.height / 2 };
  const px = side === "right" ? r.left + r.width / 2 : r.left;
  const py = side === "down" ? r.top + r.height / 2 : r.top;
  return { side, preview: { x: px, y: py, ...half } };
}

function findTarget(x: number, y: number): TabDropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-group]");
  const group = el?.dataset.group;
  if (!el || !group) return null;
  const bar = el.querySelector<HTMLElement>(".tabbar");
  const br = bar?.getBoundingClientRect();
  if (bar && br && y >= br.top && y <= br.bottom) {
    const tabs = [...bar.querySelectorAll<HTMLElement>(".tab")];
    let index = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    const ref = tabs[index]?.getBoundingClientRect() ?? tabs[tabs.length - 1]?.getBoundingClientRect();
    const lx = !ref ? br.left + 12 : tabs[index] ? ref.left - 3 : ref.right + 3;
    return { group, index, preview: { x: br.left, y: br.top, w: br.width, h: br.height }, line: { x: lx, y: br.top + 9, h: br.height - 18 } };
  }
  const body = el.querySelector<HTMLElement>(".pane")?.getBoundingClientRect();
  if (!body) return null;
  return { group, ...bodyTarget(body, x, y) };
}

/** Pointer down on a tab: becomes a drag once the pointer moves a little. */
export function pressTab(e: PointerEvent, id: string, from: string, name: string) {
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  // No text selection starts from a press on a tab, also not while the pointer crosses the editor.
  const noSelect = (ev: Event) => ev.preventDefault();
  document.addEventListener("selectstart", noSelect);
  const move = (ev: PointerEvent) => {
    if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
    if (!started) {
      started = true;
      Object.assign(tabDrag, { id, from, name });
      document.body.classList.add("tab-dragging");
      window.getSelection()?.removeAllRanges();
    }
    tabDrag.x = ev.clientX;
    tabDrag.y = ev.clientY;
    tabDrag.target = findTarget(ev.clientX, ev.clientY);
  };
  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    document.removeEventListener("selectstart", noSelect);
    document.body.classList.remove("tab-dragging");
    if (!started) return;
    const target = tabDrag.target;
    Object.assign(tabDrag, { id: null, from: null, name: "", target: null });
    justDropped = true;
    setTimeout(() => (justDropped = false), 0);
    if (drop && target) moveTab(id, from, target.group, { index: target.index, side: target.side });
  };
  const up = () => end(true);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    end(false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}
