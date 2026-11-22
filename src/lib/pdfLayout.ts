/** Where the pages of a PDF lie, computed from their sizes alone: no DOM, so any page count is cheap. */

export const PAGE_GAP = 14;
export const PAGE_PADDING = 16;
/** Browsers stop laying out near 33 million px. A longer document scrolls through a compressed range. */
export const MAX_SCROLL_HEIGHT = 16_000_000;

export class PdfLayout {
  readonly count: number;
  /** Size at scale 1: page 1's until the real page has been loaded. */
  readonly widths: Float32Array;
  readonly heights: Float32Array;
  readonly scales: Float32Array;
  readonly tops: Float64Array;
  /** Height of the whole document in px. */
  total = 0;
  widest = 0;
  /** Scroll px per document px: 1 unless the document is longer than MAX_SCROLL_HEIGHT. */
  compress = 1;

  constructor(
    count: number,
    width: number,
    height: number,
    private scaleFor: (pageWidth: number) => number,
  ) {
    this.count = count;
    this.widths = new Float32Array(count).fill(width);
    this.heights = new Float32Array(count).fill(height);
    this.scales = new Float32Array(count);
    this.tops = new Float64Array(count);
    this.relayout(scaleFor);
  }

  /** Recomputes everything for a new zoom or width. */
  relayout(scaleFor = this.scaleFor) {
    this.scaleFor = scaleFor;
    // Most documents have one page size: one scale computation is enough for those.
    let lastWidth = -1;
    let lastScale = 1;
    for (let i = 0; i < this.count; i++) {
      if (this.widths[i] !== lastWidth) {
        lastWidth = this.widths[i];
        lastScale = scaleFor(lastWidth);
      }
      this.scales[i] = lastScale;
    }
    this.place();
  }

  private place() {
    let y = PAGE_PADDING;
    let widest = 0;
    for (let i = 0; i < this.count; i++) {
      this.tops[i] = y;
      y += this.pageHeight(i) + PAGE_GAP;
      const w = this.pageWidth(i);
      if (w > widest) widest = w;
    }
    this.total = this.count ? y - PAGE_GAP + PAGE_PADDING : 0;
    this.widest = widest;
    this.compress = this.total > MAX_SCROLL_HEIGHT ? MAX_SCROLL_HEIGHT / this.total : 1;
  }

  pageWidth = (i: number) => this.widths[i] * this.scales[i];
  pageHeight = (i: number) => this.heights[i] * this.scales[i];
  get scrollHeight() {
    return this.total * this.compress;
  }

  /**
   * Height of the scroll area for a view of `viewHeight`. When compressed, it is chosen so that the
   * largest scroll position is exactly the end of the document.
   */
  spacerHeight(viewHeight: number) {
    return this.compress === 1 ? this.total : (this.total - viewHeight) * this.compress + viewHeight;
  }

  /** Takes over the page sizes of the previous version of this document. */
  adopt(old: PdfLayout) {
    const n = Math.min(this.count, old.count);
    this.widths.set(old.widths.subarray(0, n));
    this.heights.set(old.heights.subarray(0, n));
    this.relayout();
  }

  /** Stores a page's real size. True if it differed from the estimate. */
  setSize(i: number, width: number, height: number) {
    if (Math.abs(this.widths[i] - width) < 0.01 && Math.abs(this.heights[i] - height) < 0.01) return false;
    this.widths[i] = width;
    this.heights[i] = height;
    this.scales[i] = this.scaleFor(width);
    this.place();
    return true;
  }

  /** 0-based page at document position `y`. */
  pageAt(y: number) {
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** First and last 0-based page within `margin` px of the view. */
  range(y: number, viewHeight: number, margin: number): [number, number] {
    let first = this.pageAt(y - margin);
    if (first < this.count - 1 && this.tops[first] + this.pageHeight(first) < y - margin) first++;
    return [first, Math.max(first, this.pageAt(y + viewHeight + margin))];
  }

  /** A position as page and fraction, so it survives a change of zoom or page sizes. */
  anchor(y: number) {
    const page = this.pageAt(y);
    return { page, fraction: (y - this.tops[page]) / Math.max(1, this.pageHeight(page)) };
  }
  resolve(a: { page: number; fraction: number }) {
    const page = Math.min(a.page, this.count - 1);
    return this.tops[page] + a.fraction * this.pageHeight(page);
  }
}

/** Which pages to render, nearest to the middle of the view first. */
export function renderOrder(first: number, last: number, center: number): number[] {
  const out: number[] = [];
  const start = Math.max(first, Math.min(last, center));
  for (let d = 0; out.length <= last - first; d++) {
    if (start + d <= last) out.push(start + d);
    if (d > 0 && start - d >= first) out.push(start - d);
  }
  return out;
}

/**
 * Bitmaps to free so the rest fits `budget` pixels and at most `maxExtra` pages outside the view
 * remain: farthest from `center` first, never a kept one.
 */
export function evictions(items: { index: number; pixels: number; keep: boolean }[], center: number, budget: number, maxExtra = Infinity): number[] {
  let total = items.reduce((sum, x) => sum + x.pixels, 0);
  const extra = items.filter((y) => !y.keep).sort((a, b) => Math.abs(b.index - center) - Math.abs(a.index - center));
  const out: number[] = [];
  for (const [i, x] of extra.entries()) {
    if (total <= budget && extra.length - i <= maxExtra) break;
    total -= x.pixels;
    out.push(x.index);
  }
  return out;
}
