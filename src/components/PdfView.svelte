<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { onDestroy, tick } from "svelte";
  import * as pdfjs from "pdfjs-dist";
  import { addPageLinks, createPageShell, paintPage, resolvePdfDest, type PageLink } from "../lib/pdfPages";
  import { MAX_PDF_ZOOM, pageAt, pagesNear, safePdfUrl, stepZoom } from "../lib/viewer";
  import { openUrl } from "../lib/native";
  import { t } from "../lib/i18n/index.svelte";

  let { bytes }: { bytes: Uint8Array } = $props();

  interface Entry {
    page: pdfjs.PDFPageProxy;
    wrap: HTMLDivElement;
    vp: pdfjs.PageViewport;
    task: ReturnType<typeof paintPage> | null;
  }

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
  let seq = 0;

  const scaleFor = (pageW: number) => zoom || Math.max(0.3, ((scroller?.clientWidth ?? 800) - 32) / pageW);

  function release(e: Entry) {
    e.task?.cancel();
    e.task = null;
    e.wrap.replaceChildren();
  }

  function paint(e: Entry) {
    if (e.task) return;
    const task = paintPage(e.page, e.wrap, e.vp, window.devicePixelRatio || 1);
    e.task = task;
    task.promise.then(
      () => {
        if (e.task === task) void addPageLinks(e.page, e.vp, e.wrap, openLink);
      },
      () => {}, // cancelled, or one bad page: the others still show
    );
  }

  /** Sizes every page for the current zoom; only pages near the view hold a canvas. */
  function layout() {
    if (!entries.length || !scroller) return;
    const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    for (const e of entries) {
      release(e);
      const base = e.page.getViewport({ scale: 1 });
      e.vp = e.page.getViewport({ scale: scaleFor(base.width) });
      e.wrap.style.width = `${e.vp.width}px`;
      e.wrap.style.height = `${e.vp.height}px`;
    }
    shownScale = entries[0].vp.scale;
    scroller.scrollTop = ratio * scroller.scrollHeight;
    tops = entries.map((e) => e.wrap.offsetTop);
    heights = entries.map((e) => e.vp.height);
    onScroll();
  }

  /** Keeps a canvas only for pages near the view, so long PDFs stay light. */
  function onScroll() {
    if (!scroller || !tops.length) return;
    current = pageAt(tops, scroller.scrollTop + scroller.clientHeight / 3);
    const near = pagesNear(tops, heights, scroller.scrollTop, scroller.clientHeight, 800);
    if (!near) return;
    entries.forEach((e, i) => {
      if (i >= near[0] && i <= near[1]) paint(e);
      else if (e.task) release(e);
    });
  }

  async function openLink(link: PageLink) {
    if (link.url) {
      const url = safePdfUrl(link.url);
      if (url) void openUrl(url);
      return;
    }
    if (!doc || !link.dest || !scroller) return;
    const target = await resolvePdfDest(doc, link.dest);
    const e = target && entries[target.index];
    if (!target || !e) return;
    const base = e.page.getViewport({ scale: 1 });
    const top = target.y !== null ? (base.height - target.y) * e.vp.scale : 0;
    scroller.scrollTo({ top: e.wrap.offsetTop + top - 12 });
  }

  function teardown() {
    for (const e of entries) e.task?.cancel();
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
      const built: Entry[] = [];
      for (let i = 1; i <= next.numPages; i++) {
        const page = await next.getPage(i);
        if (mine !== seq) return void next.destroy();
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: scaleFor(base.width) });
        built.push({ page, vp, wrap: createPageShell(i, vp), task: null });
      }
      teardown();
      doc = next;
      entries = built;
      error = null;
      total = next.numPages;
      await tick(); // a previous error hid the scroller, and fit width needs its size
      if (mine !== seq) return;
      pagesEl!.replaceChildren(...built.map((e) => e.wrap));
      layout();
    } catch {
      if (mine !== seq) return;
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
  .scroller { position: relative; flex: 1; min-height: 0; overflow: auto; padding: 16px; }
  .scroller.gone { display: none; }
  .pages { display: flex; flex-direction: column; align-items: center; gap: 14px; width: max-content; min-width: 100%; }
  .pages :global(.page) { position: relative; flex-shrink: 0; border-radius: 6px; overflow: hidden; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); background: white; }
  .pages :global(canvas) { width: 100%; height: 100%; display: block; }
  .pages :global(.link) { position: absolute; border-radius: 3px; cursor: pointer; }
  .pages :global(.link:hover) { background: rgba(52, 120, 246, 0.14); box-shadow: 0 0 0 1px rgba(52, 120, 246, 0.35); }
  .message { margin: auto; max-width: 420px; padding: 16px; text-align: center; color: var(--label-2); }
  .message p { margin: 0; }
</style>
