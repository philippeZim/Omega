/** Ctrl + wheel (and trackpad pinch, which arrives as ctrl + wheel with small deltas) zooms a view. */

/** Scale change per wheel pixel: one notch (100 px) is about the 25 % of the zoom buttons. */
const PER_PIXEL = 0.00223;
const LINE_PX = 16;
const PAGE_PX = 400;
/** Wheel events are collected for this long, so a fast wheel causes one layout per frame. */
const APPLY_MS = 16;

export interface WheelZoomTarget {
  /** The current scale, also when the view is in a fit mode. */
  scale(): number;
  min: number;
  max: number;
  /** Go to `scale`, keeping the point at `x`, `y` (px from the element's corner) where it is. */
  apply(scale: number, x: number, y: number): void;
}

/** The factor one wheel event stands for. Multiplying keeps in and out symmetric. */
export function wheelFactor(deltaY: number, deltaMode: number) {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY;
  return Math.exp(-px * PER_PIXEL);
}

/** Listens on `el`; returns the way to stop. */
export function wheelZoom(el: HTMLElement, target: WheelZoomTarget) {
  let next: number | null = null;
  let x = 0;
  let y = 0;
  let timer = 0;
  const flush = () => {
    timer = 0;
    if (next === null) return;
    const scale = next;
    next = null;
    if (scale !== target.scale()) target.apply(scale, x, y);
  };
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    // Neither the page below nor the app's own UI zoom may react as well.
    e.preventDefault();
    e.stopPropagation();
    next = Math.min(target.max, Math.max(target.min, (next ?? target.scale()) * wheelFactor(e.deltaY, e.deltaMode)));
    const r = el.getBoundingClientRect();
    x = e.clientX - r.left;
    y = e.clientY - r.top;
    timer ||= window.setTimeout(flush, APPLY_MS);
  };
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    el.removeEventListener("wheel", onWheel);
    clearTimeout(timer);
  };
}
