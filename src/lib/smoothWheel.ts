/**
 * Smooth mouse-wheel scrolling (#297).
 *
 * WebKitGTK animates every wheel notch with its own ease-in-out curve and restarts it at speed 0
 * on the next notch, so a turning wheel makes the page pulse (measured: 27 → 12 → 25 px per frame
 * at one notch every 80 ms). Here each notch is released into a target as a ramp spread over the
 * time until the next notch is expected (the wheel's recent rhythm), and the scroll position follows
 * that target on a critically damped spring. A turning wheel thus becomes an even speed (simulated:
 * 31–38 px per frame instead of 12–27), a single notch still lands within ~150 ms, and the motion is
 * time-based, so a late frame doesn't change the pace.
 *
 * Only notched wheels are handled. Touchpads (and free-spinning high-resolution wheels) send a
 * stream of small deltas that WebKit already follows 1:1 and with kinetic scrolling; those stay native.
 */

/** Spring stiffness ω (1/s) of the position following the target. */
export const OMEGA = 40;
/** A first notch (no rhythm known yet) is released over this many seconds. */
const FIRST_RAMP_S = 0.06;
/** Notches further apart than this don't form a rhythm. */
const RHYTHM_MAX_S = 0.2;
/** Deltas below this many px come from touchpads or high-resolution wheels. A notch is ~3 lines. */
const NOTCH_MIN_PX = 40;
/** A small delta this recently marks the stream as a touchpad gesture. */
const TOUCHPAD_MS = 250;
const LINE_PX = 40;
/** Longest time step per frame (s). */
const MAX_STEP_S = 0.022;

/**
 * One step of a critically damped spring towards 0 (exact solution, so any `dt` is stable).
 * `d` is the distance to the target, `v` the velocity (px/s); returns both after `dt` seconds.
 */
export function springStep(d: number, v: number, omega: number, dt: number): [number, number] {
  const e = Math.exp(-omega * dt);
  const c = v + omega * d;
  return [(d + c * dt) * e, (v - omega * c * dt) * e];
}

/** The wheel event in px along y, or 0 if it isn't one this module animates. */
export function notchDelta(e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">, sinceSmall: number): number {
  if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return 0;
  if (e.deltaX !== 0 || e.deltaY === 0) return 0;
  const px = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? 0 : e.deltaY;
  if (Math.abs(px) < NOTCH_MIN_PX || sinceSmall < TOUCHPAD_MS) return 0;
  return px;
}

const maxTop = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);

/** The element a vertical wheel over `start` scrolls: the nearest one that can still move that way. */
export function scrollTarget(start: Element | null, dy: number): HTMLElement | null {
  for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
    // A few px of overflow come from boxes that only scroll sideways (overflow-x makes y "auto" too).
    if (!(el instanceof HTMLElement) || el.scrollHeight - el.clientHeight < 4) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll") continue;
    if (dy > 0 ? el.scrollTop < maxTop(el) - 0.5 : el.scrollTop > 0.5) return el;
  }
  return null;
}

interface Anim {
  el: HTMLElement;
  /** Exact position (scrollTop is rounded by the engine). */
  pos: number;
  target: number;
  v: number;
  /** Distance of the notches not yet released into `target`, and the speed it's released at (px/s). */
  pending: number;
  rate: number;
  /** Time of the last notch and the smoothed interval between notches (s), 0 = no rhythm. */
  lastNotch: number;
  interval: number;
  /** What was last written to scrollTop, to notice scrolling from elsewhere. */
  written: number;
  last: number;
  frame: number;
}

/** Installs the wheel handler on `win`; returns the way to remove it. */
export function installSmoothWheel(win: Window = window): () => void {
  let anim: Anim | null = null;
  let lastSmall = -Infinity;
  const reduced = win.matchMedia?.("(prefers-reduced-motion: reduce)");

  const stop = () => {
    if (anim) cancelAnimationFrame(anim.frame);
    anim = null;
  };

  const tick = (now: number) => {
    const a = anim;
    if (!a) return;
    if (!a.el.isConnected) return stop();
    // Moved by something else (scrollbar drag, keyboard, CodeMirror keeping its anchor when line
    // heights get measured): shift the whole motion along instead of fighting it.
    const shift = a.el.scrollTop - a.written;
    if (Math.abs(shift) > 1) {
      a.pos += shift;
      a.target += shift;
    }
    const max = maxTop(a.el);
    // A late frame (the main thread was busy, e.g. rendering a new stretch of the document) only
    // counts as a bit more than one: catching up all at once would show as a jump.
    const dt = Math.min(MAX_STEP_S, Math.max(0, (now - a.last) / 1000));
    a.last = now;
    const step = Math.sign(a.pending) * Math.min(Math.abs(a.pending), a.rate * dt);
    a.pending -= step;
    a.target += step;
    // At an end, what's still pending has nowhere to go.
    if ((a.pending > 0 && a.target >= max) || (a.pending < 0 && a.target <= 0)) a.pending = 0;
    a.target = Math.min(max, Math.max(0, a.target));
    const [d, v] = springStep(a.pos - a.target, a.v, OMEGA, dt);
    a.pos = a.target + d;
    a.v = v;
    const done = a.pending === 0 && Math.abs(d) < 0.5 && Math.abs(v) < 20;
    if (done) a.pos = a.target;
    a.pos = Math.min(max, Math.max(0, a.pos));
    a.el.scrollTop = a.pos;
    a.written = a.el.scrollTop;
    if (done) anim = null;
    else a.frame = requestAnimationFrame(tick);
  };

  const onWheel = (e: WheelEvent) => {
    // Views with their own wheel handling (terminal, Ctrl+wheel zoom) have taken it already.
    if (e.defaultPrevented || reduced?.matches) return;
    const raw = e.deltaMode === 0 ? Math.abs(e.deltaY) : Infinity;
    if (raw > 0 && raw < NOTCH_MIN_PX) lastSmall = e.timeStamp;
    const dy = notchDelta(e, e.timeStamp - lastSmall);
    if (!dy) return;
    const el = scrollTarget(e.target as Element, dy);
    if (!el) return;
    e.preventDefault();
    const now = performance.now();
    if (!anim || anim.el !== el) {
      stop();
      const top = el.scrollTop;
      anim = { el, pos: top, target: top, v: 0, pending: 0, rate: 0, lastNotch: -Infinity, interval: 0, written: top, last: now, frame: 0 };
      anim.frame = requestAnimationFrame(tick);
    }
    const a = anim;
    // Reversing direction drops the rest of the old motion, like a wheel normally feels.
    if (Math.sign(dy) !== Math.sign(a.pending + a.target - a.pos) && Math.abs(a.pending + a.target - a.pos) > 1) {
      a.pending = 0;
      a.target = a.pos;
      a.interval = 0;
    }
    const gap = (now - a.lastNotch) / 1000;
    a.lastNotch = now;
    a.interval = gap < RHYTHM_MAX_S ? (a.interval ? (a.interval + gap) / 2 : gap) : 0;
    a.pending += dy;
    a.rate = Math.abs(a.pending) / Math.max(1 / 120, a.interval || FIRST_RAMP_S);
  };

  win.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    win.removeEventListener("wheel", onWheel);
    stop();
  };
}
