<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { onDestroy, tick, untrack } from "svelte";
  import * as pdfjs from "pdfjs-dist";
  import { loadPdf, type PageLink } from "../lib/pdfPages";
  import { PdfPager } from "../lib/pdfPager";
  import { FileRangeTransport, RANGE_CHUNK } from "../lib/pdfRange";
  import { MAX_PDF_ZOOM, MIN_ZOOM, safePdfUrl, stepZoom } from "../lib/viewer";
  import { wheelZoom } from "../lib/wheelZoom";
  import { rememberViewer, viewerPlace } from "../lib/viewerMemory";
  import type { PdfFile } from "../lib/viewerData";
  import { openUrl } from "../lib/native";
  import { t } from "../lib/i18n/index.svelte";

  /** `onReadFailed`: `changed` if the file is another version than the open document, so its tab should reload. */
  let { tabId, source, onReadFailed }: { tabId?: string; source: PdfFile; onReadFailed?: (changed: boolean) => void } = $props();

  // A tab switch unmounts this view: it comes back where it was, at the same zoom.
  const place = untrack(() => (tabId ? viewerPlace(tabId) : undefined));
  let zoom = $state(place?.zoom ?? 0); // 0 = fit width
  let shownScale = $state(1);
  let current = $state(0);
  let total = $state(0);
  let error = $state<string | null>(null);
  let scroller = $state<HTMLDivElement>();
  let pagesEl = $state<HTMLDivElement>();
  let pager: PdfPager | null = null;
  let transport: FileRangeTransport | null = null;
  let seq = 0;
  /** Stops a load that hasn't produced a document yet. */
  let pendingDrop: (() => void) | null = null;

  function getPager() {
    pager ??= new PdfPager({
      scroller: scroller!,
      pages: pagesEl!,
      zoom: () => zoom,
      openLink,
      pageError: () => t("app.viewer.pageFailed"),
      onView: (v) => {
        current = v.page;
        total = v.total;
        shownScale = v.scale;
        if (tabId) rememberViewer(tabId, { zoom, anchor: v.anchor });
      },
    });
    return pager;
  }

  function openLink(link: PageLink) {
    if (link.url) {
      const url = safePdfUrl(link.url);
      if (url) void openUrl(url);
    } else if (link.dest) void pager?.gotoDest(link.dest);
  }

  function teardown() {
    void pager?.clear()?.destroy();
    transport?.close();
    transport = null;
  }

  function fail(message: string) {
    teardown();
    total = 0;
    error = message;
  }

  async function open(file: PdfFile) {
    const mine = ++seq;
    let next!: FileRangeTransport;
    const onRangeFail = (changed: boolean) => {
      if (mine !== seq) return;
      // Another version: what's on screen stays until the reload replaces it.
      if (!changed) fail(t("app.viewer.brokenPdf"));
      onReadFailed?.(changed);
    };
    const loading = loadPdf(() => {
      next?.close();
      next = new FileRangeTransport(file, onRangeFail);
      return { range: next, rangeChunkSize: RANGE_CHUNK, disableAutoFetch: true, disableStream: true };
    });
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
      error = null;
      await tick(); // a previous error hid the scroller, and fit width needs its size
      if (mine !== seq || !scroller) return drop();
      pendingDrop = null;
      const p = getPager();
      // Without a document on screen (first load, or after a failed read) it returns to the tab's
      // latest place; a reload over a document stays where the reader is.
      const old = p.attach(opened, first, p.hasDocument ? null : (tabId ? viewerPlace(tabId) : place)?.anchor);
      void old?.destroy();
      transport?.close();
      transport = next;
    } catch {
      if (mine !== seq) return;
      pendingDrop = null;
      drop();
      fail(t("app.viewer.brokenPdf"));
    }
  }

  $effect(() => {
    const file = source;
    pendingDrop?.();
    pendingDrop = null;
    void open(file);
  });

  let lastZoom = place?.zoom ?? 0;
  $effect(() => {
    const z = zoom;
    if (z === lastZoom) return;
    lastZoom = z;
    pager?.relayout();
  });

  $effect(() => {
    if (!scroller) return;
    return wheelZoom(scroller, {
      scale: () => pager?.scale ?? shownScale,
      min: MIN_ZOOM,
      max: MAX_PDF_ZOOM,
      apply: (scale, x, y) => {
        if (!pager) return;
        pager.zoomAt(() => (zoom = lastZoom = scale), x, y);
      },
    });
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
      timer = window.setTimeout(() => pager?.relayout(), 150);
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
<div class="scroller" class:gone={!!error} bind:this={scroller} onscroll={() => pager?.sync()}>
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
  .pages :global(.page-error) { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; font-size: 12px; color: #777; }
  .pages :global(canvas) { width: 100%; height: 100%; display: block; }
  .pages :global(.link) { position: absolute; border-radius: 3px; cursor: pointer; }
  .pages :global(.link:hover) { background: rgba(52, 120, 246, 0.14); box-shadow: 0 0 0 1px rgba(52, 120, 246, 0.35); }
  .message { margin: auto; max-width: 420px; padding: 16px; text-align: center; color: var(--label-2); }
  .message p { margin: 0; }
</style>
