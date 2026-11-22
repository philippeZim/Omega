/**
 * Shows a pdf.js document in a scroller for the PDF viewer tab and the LaTeX panel, at any length:
 * only pages near the view are in the DOM, one page renders at a time (the visible one first), and
 * a page keeps its old bitmap until the new one is ready.
 */
import type * as pdfjs from "pdfjs-dist";
import { addPageLinks, renderPage, resolvePdfDest, type PageLink } from "./pdfPages";
import { PdfLayout, evictions, renderOrder } from "./pdfLayout";

export type PdfAnchor = { page: number; fraction: number };

export interface PagerHost {
  scroller: HTMLElement;
  pages: HTMLElement;
  /** Fixed zoom, 0 for fit width. */
  zoom(): number;
  openLink(link: PageLink): void;
  /** Shown on a page that can't be rendered. */
  pageError(): string;
  onView?(view: { page: number; total: number; scale: number; anchor: PdfAnchor }): void;
}

/** A page that is near the view, or whose bitmap is still kept. */
interface Slot {
  index: number;
  /** Positioned in the document. */
  holder: HTMLDivElement;
  /** The page itself, inside `holder`: canvas and links. */
  wrap: HTMLDivElement;
  page: pdfjs.PDFPageProxy | null;
  canvas: HTMLCanvasElement | null;
  /** The scale `canvas` was rendered at. */
  scale: number;
  /** `canvas` shows the previous version of the document. */
  stale: boolean;
  failed: boolean;
}
/** The one render in progress. */
interface Job {
  slot: Slot;
  scale: number;
  task: { cancel(): void } | null;
}

/** Pages this far outside the view are in the DOM and rendered ahead. */
const NEAR_PX = 600;
/** Canvas pixels kept for all pages together (about 190 MB). */
const BITMAP_BUDGET = 48_000_000;
/** After a zoom the old bitmaps show scaled; the sharp ones are rendered once the zoom has settled. */
const ZOOM_SETTLE_MS = 120;

const freeCanvas = (c: HTMLCanvasElement | null) => {
  if (c) c.width = c.height = 0; // WebKit frees the bitmap only then
};

export class PdfPager {
  private doc: pdfjs.PDFDocumentProxy | null = null;
  private layout: PdfLayout | null = null;
  private slots = new Map<number, Slot>();
  private job: Job | null = null;
  private settleTimer = 0;

  constructor(private readonly host: PagerHost) {}

  get hasDocument() {
    return !!this.doc;
  }

  private scaleFor(width: number) {
    const zoom = this.host.zoom();
    return (pageW: number) => zoom || Math.max(0.3, (width - 32) / pageW);
  }
  private docY() {
    return this.layout ? this.host.scroller.scrollTop / this.layout.compress : 0;
  }
  private near() {
    return this.layout!.range(this.docY(), this.host.scroller.clientHeight, NEAR_PX);
  }

  private makeSlot(index: number): Slot {
    const holder = document.createElement("div");
    holder.className = "slot";
    const wrap = document.createElement("div");
    wrap.className = "page";
    wrap.dataset.page = String(index + 1);
    holder.appendChild(wrap);
    const slot: Slot = { index, holder, wrap, page: null, canvas: null, scale: 0, stale: false, failed: false };
    this.slots.set(index, slot);
    return slot;
  }

  /** Left and top of a page in the scroller's content. */
  private position(index: number) {
    const l = this.layout!;
    const { scroller } = this.host;
    return {
      left: Math.max(16, (Math.max(scroller.clientWidth, l.widest + 32) - l.pageWidth(index)) / 2),
      // In a compressed document the mounted pages follow the view instead of their scroll position.
      top: l.compress === 1 ? l.tops[index] : scroller.scrollTop + l.tops[index] - this.docY(),
    };
  }

  private place(s: Slot) {
    const l = this.layout!;
    const { left, top } = this.position(s.index);
    s.holder.style.cssText = `left:${left}px;top:${top}px;width:${l.pageWidth(s.index)}px;height:${l.pageHeight(s.index)}px`;
  }

  private sizeSpacer() {
    const { pages, scroller } = this.host;
    pages.style.height = this.layout ? `${this.layout.scrollHeight}px` : "";
    pages.style.width = this.layout ? `${Math.max(scroller.clientWidth, this.layout.widest + 32)}px` : "";
  }

  /** Sizes the scroll area. If that made a scrollbar appear or go, fit width is computed again for the new width. */
  private fitSpacer(usedWidth: number) {
    const l = this.layout!;
    this.sizeSpacer();
    const width = this.host.scroller.clientWidth;
    if (width === usedWidth) return;
    l.relayout(this.scaleFor(width));
    this.sizeSpacer();
  }

  private freeSlot(s: Slot) {
    if (this.job?.slot === s) this.cancelJob();
    s.holder.remove();
    freeCanvas(s.canvas);
    s.page?.cleanup();
    this.slots.delete(s.index);
  }

  private cancelJob() {
    this.job?.task?.cancel();
    this.job = null;
  }

  /** Mounts the pages near the view, unmounts the rest, and keeps rendering going. */
  sync = () => {
    const l = this.layout;
    if (!l) return;
    const { scroller, pages } = this.host;
    const y = this.docY();
    const [first, last] = this.near();
    for (const s of [...this.slots.values()]) {
      if (s.index >= first && s.index <= last) continue;
      // A bitmap of an older version of the document is worthless once it's out of sight.
      if (s.canvas && !s.stale) s.holder.remove();
      else this.freeSlot(s);
    }
    for (let i = first; i <= last; i++) {
      const s = this.slots.get(i) ?? this.makeSlot(i);
      this.place(s);
      if (!s.holder.isConnected) pages.appendChild(s.holder);
    }
    this.host.onView?.({ page: l.pageAt(y + scroller.clientHeight / 3) + 1, total: l.count, scale: l.scales[0], anchor: l.anchor(y) });
    this.pump();
  };

  private pump() {
    const l = this.layout;
    if (!l || !this.doc || this.settleTimer) return;
    const [first, last] = this.near();
    const job = this.job;
    if (job && (job.slot.index < first || job.slot.index > last || job.scale !== l.scales[job.slot.index])) this.cancelJob();
    const center = l.pageAt(this.docY() + this.host.scroller.clientHeight / 2);
    this.evict(center, first, last); // also during long scrolling, when rendering never goes idle
    if (this.job) return;
    for (const i of renderOrder(first, last, center)) {
      const s = this.slots.get(i);
      if (s && !s.failed && (!s.canvas || s.stale || s.scale !== l.scales[i])) return void this.start(s);
    }
  }

  private evict(center: number, first: number, last: number) {
    const items = [...this.slots.values()].filter((s) => s.canvas).map((s) => ({ index: s.index, pixels: s.canvas!.width * s.canvas!.height, keep: s.index >= first && s.index <= last }));
    for (const i of evictions(items, center, BITMAP_BUDGET)) this.freeSlot(this.slots.get(i)!);
  }

  private async start(s: Slot) {
    const mine: Job = { slot: s, scale: this.layout!.scales[s.index], task: null };
    this.job = mine;
    const owner = this.doc!;
    try {
      if (!s.page) {
        const page = await owner.getPage(s.index + 1);
        if (this.doc !== owner) return;
        s.page = page;
        if (this.applyRealSize(s.index, page)) mine.scale = this.layout!.scales[s.index];
        if (this.job !== mine) return this.pump();
      }
      const page = s.page;
      const vp = page.getViewport({ scale: mine.scale });
      const { canvas, task } = renderPage(page, vp, window.devicePixelRatio || 1);
      mine.task = task;
      try {
        await task.promise;
      } catch (e) {
        freeCanvas(canvas);
        throw e;
      }
      if (this.job !== mine) return freeCanvas(canvas);
      freeCanvas(s.canvas);
      s.canvas = canvas;
      s.scale = mine.scale;
      s.stale = false;
      s.wrap.replaceChildren(canvas); // the old bitmap stays on screen until this moment
      this.job = null;
      void addPageLinks(page, vp, s.wrap, this.host.openLink);
    } catch (e) {
      if (this.job !== mine) return;
      this.job = null;
      if ((e as { name?: string })?.name !== "RenderingCancelledException") this.showFailed(s);
    }
    this.pump();
  }

  /** One bad page: the others still show. An older version's bitmap must not pass for this page. */
  private showFailed(s: Slot) {
    s.failed = true;
    freeCanvas(s.canvas);
    s.canvas = null;
    s.stale = false;
    const note = document.createElement("div");
    note.className = "page-error";
    note.textContent = this.host.pageError();
    s.wrap.replaceChildren(note);
  }

  /** The page differs from the estimate: moves what follows and keeps the view where it was. */
  private applyRealSize(index: number, page: pdfjs.PDFPageProxy) {
    const l = this.layout!;
    const base = page.getViewport({ scale: 1 });
    const anchor = l.anchor(this.docY());
    if (!l.setSize(index, base.width, base.height)) return false;
    this.sizeSpacer();
    this.host.scroller.scrollTop = l.resolve(anchor) * l.compress;
    for (const x of this.slots.values()) if (x.holder.isConnected) this.place(x);
    return true;
  }

  /**
   * Shows `doc`, of which `first` is page 1, and returns the document it replaces. The view stays
   * where it was (or goes to `resume`), and pages keep their old bitmap until the new one is ready.
   */
  attach(doc: pdfjs.PDFDocumentProxy, first: pdfjs.PDFPageProxy, resume?: PdfAnchor | null) {
    const { scroller } = this.host;
    const old = this.doc;
    const before = this.layout;
    const anchor = resume ?? before?.anchor(this.docY()) ?? null;
    this.cancelJob();
    const base = first.getViewport({ scale: 1 });
    const width = scroller.clientWidth;
    const next = new PdfLayout(doc.numPages, base.width, base.height, this.scaleFor(width));
    // A new version of a document mostly has the same page sizes: no jumps while they are confirmed.
    if (before) next.adopt(before);
    next.setSize(0, base.width, base.height);
    this.doc = doc;
    this.layout = next;
    this.fitSpacer(width);
    scroller.scrollTop = anchor ? next.resolve(anchor) * next.compress : 0;
    const [from, to] = this.near();
    for (const s of [...this.slots.values()]) {
      if (s.index >= doc.numPages || s.index < from || s.index > to) {
        s.page = null; // belongs to the old document, which the caller destroys
        this.freeSlot(s);
        continue;
      }
      s.page = null;
      s.stale = true;
      s.failed = false;
    }
    const s = this.slots.get(0) ?? (from === 0 ? this.makeSlot(0) : null);
    if (s) s.page = first;
    this.sync();
    return old;
  }

  /** New zoom or width: pages take their new size at once, showing the old bitmap until the sharp one is ready. */
  relayout = () => {
    const l = this.layout;
    if (!l) return;
    const { scroller } = this.host;
    const anchor = l.anchor(this.docY());
    const width = scroller.clientWidth;
    l.relayout(this.scaleFor(width));
    this.fitSpacer(width);
    scroller.scrollTop = l.resolve(anchor) * l.compress;
    if (this.job && this.job.scale !== l.scales[this.job.slot.index]) this.cancelJob();
    for (const s of this.slots.values()) s.failed = false; // worth another try at the new scale
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = 0;
      this.pump();
    }, ZOOM_SETTLE_MS);
    this.sync();
  };

  /** Loads a page's real size, also of a page that isn't mounted. False if the document changed meanwhile. */
  async ensureSize(index: number) {
    const owner = this.doc;
    if (!owner || !this.layout || index < 0 || index >= this.layout.count) return false;
    const page = await owner.getPage(index + 1).catch(() => null);
    if (this.doc !== owner || !this.layout) return false;
    if (page) this.applyRealSize(index, page);
    return true;
  }

  /** Where a page is: `docTop` for `scrollToDoc`, `left`/`top` in the scroller's content, its scale and size at scale 1. */
  pageBox(index: number) {
    const l = this.layout!;
    return { ...this.position(index), docTop: l.tops[index], scale: l.scales[index], width: l.widths[index], height: l.heights[index] };
  }

  /** `smooth` only for short distances: an animation across hundreds of pages would render none of them. */
  scrollToDoc(y: number, smooth = false) {
    const l = this.layout;
    if (!l) return;
    const { scroller } = this.host;
    const top = Math.max(0, y) * l.compress;
    // Compressed: mounted pages are placed from the scroll position, so it must be final at once.
    if (smooth && l.compress === 1 && scroller.scrollTo && Math.abs(top - scroller.scrollTop) <= 2 * scroller.clientHeight) scroller.scrollTo({ top, behavior: "smooth" });
    else scroller.scrollTop = top;
    this.sync(); // no waiting for the scroll event
  }

  /** Goes to a PDF destination (named, or explicit), also on a page not loaded yet. */
  async gotoDest(dest: string | unknown[], smooth = false) {
    const owner = this.doc;
    if (!owner) return;
    const target = await resolvePdfDest(owner, dest);
    if (!target || this.doc !== owner || !(await this.ensureSize(target.index))) return;
    const b = this.pageBox(target.index);
    const top = target.y !== null ? Math.max(0, (b.height - target.y) * b.scale) : 0;
    this.scrollToDoc(b.docTop + top - 12, smooth);
  }

  /** Stops everything and returns the document, for the caller to destroy. */
  clear() {
    this.cancelJob();
    clearTimeout(this.settleTimer);
    this.settleTimer = 0;
    for (const s of [...this.slots.values()]) this.freeSlot(s);
    const old = this.doc;
    this.doc = null;
    this.layout = null;
    this.sizeSpacer();
    return old;
  }
}
