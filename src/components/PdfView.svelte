<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { onDestroy, tick } from "svelte";
  import * as pdfjs from "pdfjs-dist";
  import { PDF_LOAD_OPTIONS, addPageLinks, pdfWorker, renderPage, resolvePdfDest, type PageLink } from "../lib/pdfPages";
  import { FileRangeTransport, RANGE_CHUNK } from "../lib/pdfRange";
  import { PdfLayout, evictions, renderOrder } from "../lib/pdfLayout";
  import { MAX_PDF_ZOOM, safePdfUrl, stepZoom } from "../lib/viewer";
  import { openUrl } from "../lib/native";
  import { t } from "../lib/i18n/index.svelte";

  /** `onReadFailed`: the file may have changed under the open document, so its tab should check. */
  let { source, onReadFailed }: { source: { path: string; size: number }; onReadFailed?: () => void } = $props();

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

  let zoom = $state(0); // 0 = fit width
  let shownScale = $state(1);
  let current = $state(0);
  let total = $state(0);
  let error = $state<string | null>(null);
  let scroller = $state<HTMLDivElement>();
  let pagesEl = $state<HTMLDivElement>();
  let doc: pdfjs.PDFDocumentProxy | null = null;
  let layout: PdfLayout | null = null;
  let transport: FileRangeTransport | null = null;
  const slots = new Map<number, Slot>();
  let job: Job | null = null;
  let settleTimer = 0;
  let seq = 0;

  const scaleFor = (width: number) => (pageW: number) => zoom || Math.max(0.3, (width - 32) / pageW);
  const docY = () => (scroller && layout ? scroller.scrollTop / layout.compress : 0);
  const near = () => layout!.range(docY(), scroller!.clientHeight, NEAR_PX);

  function makeSlot(index: number): Slot {
    const holder = document.createElement("div");
    holder.className = "slot";
    const wrap = document.createElement("div");
    wrap.className = "page";
    wrap.dataset.page = String(index + 1);
    holder.appendChild(wrap);
    const slot: Slot = { index, holder, wrap, page: null, canvas: null, scale: 0, failed: false };
    slots.set(index, slot);
    return slot;
  }

  function place(s: Slot) {
    const l = layout!;
    const w = l.pageWidth(s.index);
    // In a compressed document the mounted pages follow the view instead of their scroll position.
    const top = l.compress === 1 ? l.tops[s.index] : scroller!.scrollTop + l.tops[s.index] - docY();
    const left = Math.max(16, (Math.max(scroller!.clientWidth, l.widest + 32) - w) / 2);
    s.holder.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${l.pageHeight(s.index)}px`;
  }

  function sizeSpacer() {
    if (!layout || !pagesEl) return;
    pagesEl.style.height = `${layout.scrollHeight}px`;
    pagesEl.style.width = `${Math.max(scroller!.clientWidth, layout.widest + 32)}px`;
  }

  function freeSlot(s: Slot) {
    if (job?.slot === s) cancelJob();
    s.holder.remove();
    if (s.canvas) s.canvas.width = s.canvas.height = 0; // WebKit frees the bitmap only then
    s.page?.cleanup();
    slots.delete(s.index);
  }

  function cancelJob() {
    job?.task?.cancel();
    job = null;
  }

  /** Mounts the pages near the view, unmounts the rest, and keeps rendering going. */
  function sync() {
    if (!layout || !scroller || !pagesEl) return;
    const y = docY();
    current = layout.pageAt(y + scroller.clientHeight / 3) + 1;
    const [first, last] = near();
    for (const s of [...slots.values()]) {
      if (s.index >= first && s.index <= last) continue;
      if (s.canvas) s.holder.remove();
      else freeSlot(s);
    }
    for (let i = first; i <= last; i++) {
      const s = slots.get(i) ?? makeSlot(i);
      place(s);
      if (!s.holder.isConnected) pagesEl.appendChild(s.holder);
    }
    pump();
  }

  /** One render at a time, always the most useful one: the visible page first. */
  function pump() {
    if (!layout || !scroller || !doc || settleTimer) return;
    const [first, last] = near();
    if (job && (job.slot.index < first || job.slot.index > last || job.scale !== layout.scales[job.slot.index])) cancelJob();
    const center = layout.pageAt(docY() + scroller.clientHeight / 2);
    evict(center, first, last); // also during long scrolling, when rendering never goes idle
    if (job) return;
    for (const i of renderOrder(first, last, center)) {
      const s = slots.get(i);
      if (s && !s.failed && (!s.canvas || s.scale !== layout.scales[i])) return void start(s);
    }
  }

  function evict(center: number, first: number, last: number) {
    const items = [...slots.values()].filter((s) => s.canvas).map((s) => ({ index: s.index, pixels: s.canvas!.width * s.canvas!.height, keep: s.index >= first && s.index <= last }));
    for (const i of evictions(items, center, BITMAP_BUDGET)) freeSlot(slots.get(i)!);
  }

  async function start(s: Slot) {
    const mine: Job = { slot: s, scale: layout!.scales[s.index], task: null };
    job = mine;
    const owner = doc!;
    try {
      if (!s.page) {
        s.page = await owner.getPage(s.index + 1);
        if (doc !== owner) return;
        if (applyRealSize(s)) mine.scale = layout!.scales[s.index];
        if (job !== mine) return pump();
      }
      const vp = s.page.getViewport({ scale: mine.scale });
      const { canvas, task } = renderPage(s.page, vp, window.devicePixelRatio || 1);
      mine.task = task;
      await task.promise;
      if (job !== mine) {
        canvas.width = canvas.height = 0;
        return;
      }
      if (s.canvas) s.canvas.width = s.canvas.height = 0;
      s.canvas = canvas;
      s.scale = mine.scale;
      s.wrap.replaceChildren(canvas); // the old bitmap stays on screen until this moment
      job = null;
      void addPageLinks(s.page, vp, s.wrap, openLink);
    } catch (e) {
      if (job !== mine) return;
      job = null;
      if ((e as { name?: string })?.name !== "RenderingCancelledException") s.failed = true; // one bad page: the others still show
    }
    pump();
  }

  /** The page differs from the estimate: moves what follows and keeps the view where it was. */
  function applyRealSize(s: Slot) {
    const l = layout!;
    const base = s.page!.getViewport({ scale: 1 });
    const anchor = l.anchor(docY());
    if (!l.setSize(s.index, base.width, base.height)) return false;
    sizeSpacer();
    scroller!.scrollTop = l.resolve(anchor) * l.compress;
    for (const x of slots.values()) if (x.holder.isConnected) place(x);
    return true;
  }

  /** New zoom or width: pages take their new size at once, showing the old bitmap until the sharp one is ready. */
  function relayout() {
    if (!layout || !scroller) return;
    const anchor = layout.anchor(docY());
    layout.relayout(scaleFor(scroller.clientWidth));
    shownScale = layout.scales[0];
    sizeSpacer();
    scroller.scrollTop = layout.resolve(anchor) * layout.compress;
    if (job && job.scale !== layout.scales[job.slot.index]) cancelJob();
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      pump();
    }, ZOOM_SETTLE_MS);
    sync();
  }

  async function openLink(link: PageLink) {
    if (link.url) {
      const url = safePdfUrl(link.url);
      if (url) void openUrl(url);
      return;
    }
    if (!doc || !link.dest || !scroller || !layout) return;
    const owner = doc;
    const target = await resolvePdfDest(owner, link.dest);
    if (!target || doc !== owner || target.index >= layout.count) return;
    // The target may not be loaded yet, and its real height decides where the destination lies.
    const page = await owner.getPage(target.index + 1).catch(() => null);
    if (doc !== owner || !scroller || !layout) return;
    if (page) {
      const base = page.getViewport({ scale: 1 });
      layout.setSize(target.index, base.width, base.height);
      sizeSpacer();
    }
    const scale = layout.scales[target.index];
    const top = target.y !== null ? Math.max(0, (layout.heights[target.index] - target.y) * scale) : 0;
    scroller.scrollTop = (layout.tops[target.index] + top - 12) * layout.compress;
    sync(); // no waiting for the scroll event
  }

  function teardown() {
    cancelJob();
    clearTimeout(settleTimer);
    settleTimer = 0;
    for (const s of [...slots.values()]) freeSlot(s);
    layout = null;
    transport?.close();
    transport = null;
    void doc?.destroy();
    doc = null;
  }

  function fail(message: string) {
    teardown();
    total = 0;
    error = message;
  }

  async function open(file: { path: string; size: number }) {
    const mine = ++seq;
    // A reload continues where the reader was.
    const resume = layout ? layout.anchor(docY()) : null;
    const next = new FileRangeTransport(file.path, file.size, () => {
      if (mine !== seq) return;
      fail(t("app.viewer.brokenPdf"));
      onReadFailed?.();
    });
    const loading = pdfjs.getDocument({ ...PDF_LOAD_OPTIONS, worker: pdfWorker(), range: next, rangeChunkSize: RANGE_CHUNK, disableAutoFetch: true, disableStream: true });
    const drop = () => {
      next.close();
      void loading.destroy();
    };
    pendingDrop = drop;
    let opened: pdfjs.PDFDocumentProxy;
    try {
      opened = await loading.promise;
    } catch (e) {
      if (mine !== seq) return;
      pendingDrop = null;
      drop();
      fail(t((e as { name?: string })?.name === "PasswordException" ? "app.viewer.passwordPdf" : "app.viewer.brokenPdf"));
      return;
    }
    if (mine !== seq) return drop();
    try {
      // Only page 1 is needed to show the document: the others take its size until they are near.
      const first = await opened.getPage(1);
      if (mine !== seq) return drop();
      const base = first.getViewport({ scale: 1 });
      pendingDrop = null;
      teardown();
      doc = opened;
      transport = next;
      error = null;
      total = opened.numPages;
      await tick(); // a previous error hid the scroller, and fit width needs its size
      if (mine !== seq || !scroller) return;
      layout = new PdfLayout(opened.numPages, base.width, base.height, scaleFor(scroller.clientWidth));
      shownScale = layout.scales[0];
      sizeSpacer();
      scroller.scrollTop = resume ? layout.resolve(resume) * layout.compress : 0;
      const s = makeSlot(0);
      s.page = first;
      sync();
    } catch {
      if (mine !== seq) return;
      pendingDrop = null;
      drop();
      fail(t("app.viewer.brokenPdf"));
    }
  }

  /** Stops a load that hasn't produced a document yet. */
  let pendingDrop: (() => void) | null = null;

  $effect(() => {
    const file = source;
    pendingDrop?.();
    pendingDrop = null;
    void open(file);
  });

  let lastZoom = 0;
  $effect(() => {
    const z = zoom;
    if (z === lastZoom) return;
    lastZoom = z;
    relayout();
  });

  // Fit-width follows the tab width, debounced.
  $effect(() => {
    const el = scroller;
    if (!el) return;
    let last = el.clientWidth;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === last) return;
      last = el.clientWidth;
      clearTimeout(timer);
      timer = window.setTimeout(relayout, 150);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  });

  onDestroy(() => {
    seq++;
    pendingDrop?.();
    pendingDrop = null;
    teardown();
  });
</script>

<div class="toolbar">
  <span class="info">{#if total}{t("app.viewer.pageOf", { page: current || 1, total })}{/if}</span>
  <span class="spacer"></span>
  {#if total}
  <div class="zoom">
    <button class="tool round" title={t("app.viewer.zoomOut")} aria-label={t("app.viewer.zoomOut")} onclick={() => (zoom = stepZoom(shownScale, -1, MAX_PDF_ZOOM))}><Glyph name="minus" size={10} /></button>
    <span class="pct">{Math.round(shownScale * 100)} %</span>
    <button class="tool round" title={t("app.viewer.zoomIn")} aria-label={t("app.viewer.zoomIn")} onclick={() => (zoom = stepZoom(shownScale, 1, MAX_PDF_ZOOM))}><Glyph name="plus" size={10} /></button>
    <button class="tool" class:on={zoom === 0} title={t("app.viewer.fitWidthTitle")} onclick={() => (zoom = 0)}>{t("app.viewer.fitWidth")}</button>
  </div>
  {/if}
</div>

{#if error}<div class="message" role="alert"><p>{error}</p></div>{/if}
<div class="scroller" class:gone={!!error} bind:this={scroller} onscroll={sync}>
  <div class="pages" bind:this={pagesEl}></div>
</div>

<style>
  .toolbar { height: 44px; flex-shrink: 0; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid rgba(var(--fg-rgb), 0.05); }
  .info { font-size: 12px; color: var(--label-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .spacer { flex: 1; }
  .tool { display: inline-grid; place-items: center; flex-shrink: 0; white-space: nowrap; height: 26px; min-width: 26px; padding: 0 10px; border-radius: 999px; color: var(--label-2); font-size: 11.5px; }
  .tool:hover { background: var(--fill-hover); color: var(--label); }
  .tool.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  .tool.round { width: 26px; padding: 0; }
  .zoom { display: flex; align-items: center; flex-shrink: 0; gap: 2px; padding: 2px; border-radius: 999px; background: var(--recess); box-shadow: var(--recess-shadow); }
  .pct { min-width: 46px; text-align: center; font-size: 11.5px; color: var(--label-2); font-variant-numeric: tabular-nums; }
  .scroller { position: relative; flex: 1; min-height: 0; overflow: auto; }
  .scroller.gone { display: none; }
  .pages { position: relative; }
  .pages :global(.slot) { position: absolute; }
  .pages :global(.page) { position: relative; width: 100%; height: 100%; border-radius: 6px; overflow: hidden; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); background: white; }
  .pages :global(canvas) { width: 100%; height: 100%; display: block; }
  .pages :global(.link) { position: absolute; border-radius: 3px; cursor: pointer; }
  .pages :global(.link:hover) { background: rgba(52, 120, 246, 0.14); box-shadow: 0 0 0 1px rgba(52, 120, 246, 0.35); }
  .message { margin: auto; max-width: 420px; padding: 16px; text-align: center; color: var(--label-2); }
  .message p { margin: 0; }
</style>
