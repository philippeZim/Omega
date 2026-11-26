/**
 * Remembered heights of block widgets (rendered formulas, tables), handed to CodeMirror as
 * `estimatedHeight` (#297).
 *
 * Without an estimate CodeMirror assumes one text line for a block it hasn't rendered yet. When
 * scrolling reaches it, the real height differs by tens or hundreds of pixels: the viewport has to
 * be recomputed ("Measure loop restarted"), the scroll anchor corrected, and the frame is missed.
 * Once a widget has been on screen its height is known here, so the same content (also in another
 * document, or after the decorations were rebuilt) is estimated exactly.
 */

const heights = new Map<string, number>();
const keys = new WeakMap<Element, string>();
let observer: ResizeObserver | null = null;

function outerHeight(el: HTMLElement, box: number) {
  const s = getComputedStyle(el);
  return box + (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0);
}

/** Watches `el` (the widget's DOM) and remembers its height under `key`. */
export function trackHeight(el: HTMLElement, key: string) {
  keys.set(el, key);
  observer ??= new ResizeObserver((entries) => {
    for (const e of entries) {
      const key = keys.get(e.target);
      const box = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight;
      if (!key || !(box > 0)) continue;
      if (heights.size > 2000) heights.clear();
      heights.set(key, Math.round(outerHeight(e.target as HTMLElement, box)));
    }
  });
  observer.observe(el);
}

export function untrackHeight(el: HTMLElement) {
  observer?.unobserve(el);
}

/** The height `key` had when it was last rendered, if it has been. */
export const knownHeight = (key: string): number | undefined => heights.get(key);
