<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { onDestroy, tick } from "svelte";
  import * as pdfjs from "pdfjs-dist";
  import { addPageLinks, createPageShell, paintPage, resolvePdfDest, type PageLink } from "../lib/pdfPages";
  import { MAX_PDF_ZOOM, pageAt, pagesNear, safePdfUrl, stepZoom } from "../lib/viewer";
  import { openUrl } from "../lib/native";
  import { t } from "../lib/i18n/index.svelte";

  let { bytes }: { bytes: Uint8Array } = $props();

  /** One page. Its proxy is only held while the page is near the view. */
  interface Entry {
    index: number;
    wrap: HTMLDivElement;
    /** Size at scale 1: page 1's until the real page has been loaded. */
    w: number;
    h: number;
    scale: number;
    page: pdfjs.PDFPageProxy | null;
    loading: boolean;
    failed: boolean;
    task: ReturnType<typeof paintPage> | null;
  }

  const NEAR_PX = 800;

  let zoom = $state(0); // 0 = fit width
  let shownScale = $state(1);
  let current = $state(0);
  let total = $state(0);
  let error = $state<string | null>(null);
  let scroller = $state<HTMLDivElement>();
  let pagesEl = $state<HTMLDivElement>();
  let doc: pdfjs.PDFDocumentProxy | null = null;
  let entries: Entry[] = [];
  let tops: number[] = [];
  let heights: number[] = [];
  /** Pages holding a proxy, a canvas or a pending load. */
  const live = new Set<Entry>();
  let seq = 0;

  const scaleFor = (pageW: number) => zoom || Math.max(0.3, ((scroller?.clientWidth ?? 800) - 32) / pageW);

  function clearCanvas(e: Entry) {
    e.task?.cancel();
    e.task = null;
    e.wrap.replaceChildren();
  }

  function drop(e: Entry) {
    clearCanvas(e);
    live.delete(e);
    const page = e.page;
    e.page = null;
    page?.cleanup();
  }

  function paint(e: Entry) {
    if (e.task || !e.page) return;
    const page = e.page;
    const vp = page.getViewport({ scale: e.scale });
    const task = paintPage(page, e.wrap, vp, window.devicePixelRatio || 1);
    e.task = task;
    task.promise.then(
      () => {
        if (e.task === task) void addPageLinks(page, vp, e.wrap, openLink);
      },
      () => {}, // cancelled, or one bad page: the others still show
    );
  }

  /** Paints the page, fetching it first if needed. */
  function show(e: Entry) {
    if (e.failed) return;
    live.add(e);
    if (e.page) return paint(e);
    if (e.loading || !doc) return;
    e.loading = true;
    const owner = doc;
    owner.getPage(e.index + 1).then(
      (page) => {
        if (doc !== owner) return;
        e.loading = false;
        e.page = page;
        applyRealSize(e, page);
        onScroll(); // paints it, or lets it go if the view moved on
      },
      () => {
        if (doc !== owner) return;
        e.loading = false;
        e.failed = true;
        live.delete(e);
      },
    );
  }

  function sizeShell(e: Entry) {
    e.scale = scaleFor(e.w);
    e.wrap.style.width = `${e.w * e.scale}px`;
    e.wrap.style.height = `${e.h * e.scale}px`;
  }

  /** Real offsets, after all sizes are written (one reflow): with UI zoom the browser snaps sizes, so a sum would drift. */
  function measure() {
    tops = entries.map((e) => e.wrap.offsetTop);
    heights = entries.map((e) => e.wrap.offsetHeight);
  }

  /** The page differs from page 1's size: fixes its shell and keeps the view where it was. */
  function applyRealSize(e: Entry, page: pdfjs.PDFPageProxy) {
    const base = page.getViewport({ scale: 1 });
    if (base.width === e.w && base.height === e.h) return;
    const oldHeight = e.h * e.scale;
    const above = !!scroller && tops[e.index] + oldHeight <= scroller.scrollTop;
    clearCanvas(e);
    e.w = base.width;
    e.h = base.height;
    sizeShell(e);
    measure();
    if (above && scroller) scroller.scrollTop += e.h * e.scale - oldHeight;
  }

  /** Sizes every page for the current zoom; only pages near the view hold a canvas. */
  function layout() {
    if (!entries.length || !scroller) return;
    const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    for (const e of live) clearCanvas(e);
    for (const e of entries) sizeShell(e);
    shownScale = entries[0].scale;
    measure();
    scroller.scrollTop = ratio * scroller.scrollHeight;
    onScroll();
  }

  /** Keeps pages near the view loaded and painted, and lets go of the others, so long PDFs stay light. */
  function onScroll() {
    if (!scroller || !tops.length) return;
    current = pageAt(tops, scroller.scrollTop + scroller.clientHeight / 3);
    const near = pagesNear(tops, heights, scroller.scrollTop, scroller.clientHeight, NEAR_PX);
    if (!near) return;
    for (const e of [...live]) if (!e.loading && (e.index < near[0] || e.index > near[1])) drop(e);
    for (let i = near[0]; i <= near[1]; i++) show(entries[i]);
  }

  async function openLink(link: PageLink) {
    if (link.url) {
      const url = safePdfUrl(link.url);
      if (url) void openUrl(url);
      return;
    }
    if (!doc || !link.dest || !scroller) return;
    const owner = doc;
    const target = await resolvePdfDest(owner, link.dest);
    const e = target && entries[target.index];
    if (!target || !e || doc !== owner) return;
    // The target may not be loaded yet, and its real height decides where the destination lies.
    const page = e.page ?? (await owner.getPage(target.index + 1).catch(() => null));
    if (doc !== owner || !scroller) return;
    if (page) applyRealSize(e, page);
    // A destination above the page edge (common with a y meant for another page size) is its top.
    const top = target.y !== null ? Math.max(0, (e.h - target.y) * e.scale) : 0;
    scroller.scrollTo({ top: tops[e.index] + top - 12 });
    onScroll(); // no waiting for the scroll event
  }

  function teardown() {
    for (const e of live) e.task?.cancel();
    live.clear();
    entries = [];
    tops = [];
    heights = [];
    void doc?.destroy();
    doc = null;
  }

  async function open(data: Uint8Array) {
    const mine = ++seq;
    // pdf.js takes the buffer over, so it gets its own copy.
    const task = pdfjs.getDocument({ data: data.slice(), isEvalSupported: false });
    let next: pdfjs.PDFDocumentProxy;
    try {
      next = await task.promise;
    } catch (e) {
      if (mine !== seq) return;
      teardown();
      pagesEl?.replaceChildren();
      total = 0;
      error = t((e as { name?: string })?.name === "PasswordException" ? "app.viewer.passwordPdf" : "app.viewer.brokenPdf");
      return;
    }
    if (mine !== seq) return void next.destroy();
    try {
      // Only page 1 is needed to show the document: the others take its size until they are near.
      const first = await next.getPage(1);
      if (mine !== seq) return void next.destroy();
      const base = first.getViewport({ scale: 1 });
      const built: Entry[] = [];
      for (let index = 0; index < next.numPages; index++) {
        const scale = scaleFor(base.width);
        const wrap = createPageShell(index + 1, { width: base.width * scale, height: base.height * scale });
        built.push({ index, wrap, w: base.width, h: base.height, scale, page: null, loading: false, failed: false, task: null });
      }
      built[0].page = first;
      teardown();
      doc = next;
      entries = built;
      live.add(built[0]);
      error = null;
      total = next.numPages;
      await tick(); // a previous error hid the scroller, and fit width needs its size
      if (mine !== seq) return;
      pagesEl!.replaceChildren(...built.map((e) => e.wrap));
      layout();
    } catch {
      if (mine !== seq) return;
      teardown();
      pagesEl?.replaceChildren();
      total = 0;
      void next.destroy();
      error = t("app.viewer.brokenPdf");
    }
  }

  $effect(() => void open(bytes));

  let lastZoom = 0;
  $effect(() => {
    const z = zoom;
    if (z === lastZoom) return;
    lastZoom = z;
    layout();
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
      timer = window.setTimeout(() => zoom === 0 && layout(), 150);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  });

  onDestroy(() => {
    seq++;
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
<div class="scroller" class:gone={!!error} bind:this={scroller} onscroll={onScroll}>
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
  .scroller { position: relative; flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; padding: 16px; }
  .scroller.gone { display: none; }
  .pages { display: flex; flex-direction: column; align-items: center; gap: 14px; width: max-content; min-width: 100%; }
  .pages :global(.page) { position: relative; flex-shrink: 0; border-radius: 6px; overflow: hidden; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); background: white; }
  .pages :global(canvas) { width: 100%; height: 100%; display: block; }
  .pages :global(.link) { position: absolute; border-radius: 3px; cursor: pointer; }
  .pages :global(.link:hover) { background: rgba(52, 120, 246, 0.14); box-shadow: 0 0 0 1px rgba(52, 120, 246, 0.35); }
  .message { margin: auto; max-width: 420px; padding: 16px; text-align: center; color: var(--label-2); }
  .message p { margin: 0; }
</style>
