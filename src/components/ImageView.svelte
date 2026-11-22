<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { tick } from "svelte";
  import { imageSource, type ViewerData } from "../lib/viewerData";
  import { MAX_ZOOM, MIN_ZOOM, fitScale, stepZoom } from "../lib/viewer";
  import { wheelZoom } from "../lib/wheelZoom";
  import { formatSize } from "../lib/largeFile";
  import { t } from "../lib/i18n/index.svelte";

  let { data, path, onText }: { data: ViewerData; path: string; onText: (() => void) | null } = $props();

  let zoom = $state(0); // 0 = fit to the tab
  let boxW = $state(0);
  let boxH = $state(0);
  let natural = $state<{ w: number; h: number } | null>(null);
  let broken = $state(false);
  let src = $state<string | null>(null);
  let scroller = $state<HTMLDivElement>();

  $effect(() => {
    let stale = false;
    imageSource(data, path).then(
      (url) => {
        if (stale) return;
        broken = false;
        // A new picture may have another size: stay hidden until it has loaded. The same URL fires no load.
        if (url !== src) natural = null;
        src = url;
      },
      () => {
        if (!stale) broken = true;
      },
    );
    return () => void (stale = true);
  });

  const PADDING = 32;
  const scale = $derived(natural ? zoom || fitScale(natural.w, natural.h, boxW - PADDING, boxH - PADDING) : 1);

  function onLoad(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    // An SVG without a size of its own reports 0 in some engines.
    natural = { w: img.naturalWidth || 300, h: img.naturalHeight || 150 };
  }

  let image = $state<HTMLImageElement>();

  /** Ctrl + wheel: the point of the image under the cursor stays there. */
  async function zoomAt(next: number, x: number, y: number) {
    if (!scroller || !image) return;
    const box = scroller.getBoundingClientRect();
    const before = image.getBoundingClientRect();
    const fx = (box.left + x - before.left) / before.width;
    const fy = (box.top + y - before.top) / before.height;
    zoom = next;
    await tick();
    if (!scroller || !image) return;
    const after = image.getBoundingClientRect();
    scroller.scrollLeft += after.left + fx * after.width - (box.left + x);
    scroller.scrollTop += after.top + fy * after.height - (box.top + y);
  }

  $effect(() => {
    if (!scroller) return;
    return wheelZoom(scroller, { scale: () => scale, min: MIN_ZOOM, max: MAX_ZOOM, apply: (s, x, y) => void zoomAt(s, x, y) });
  });

  // Drag to pan when the image is larger than the tab.
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  let dragging = $state(false);
  const pannable = () => !!scroller && (scroller.scrollWidth > scroller.clientWidth || scroller.scrollHeight > scroller.clientHeight);

  function down(e: PointerEvent) {
    if (e.button !== 0 || !scroller || !pannable()) return;
    drag = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    dragging = true;
    scroller.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function move(e: PointerEvent) {
    if (!drag || !scroller) return;
    scroller.scrollLeft = drag.left - (e.clientX - drag.x);
    scroller.scrollTop = drag.top - (e.clientY - drag.y);
  }
  function up() {
    drag = null;
    dragging = false;
  }
</script>

<div class="toolbar">
  <span class="info">{#if natural && !broken}{natural.w} × {natural.h} · {/if}{formatSize(data.size)}</span>
  <span class="spacer"></span>
  {#if onText}<button class="tool" onclick={onText}>{t("app.viewer.openAsText")}</button>{/if}
  <div class="zoom">
    <button class="tool round" title={t("app.viewer.zoomOut")} aria-label={t("app.viewer.zoomOut")} onclick={() => (zoom = stepZoom(scale, -1))}><Glyph name="minus" size={10} /></button>
    <span class="pct">{Math.round(scale * 100)} %</span>
    <button class="tool round" title={t("app.viewer.zoomIn")} aria-label={t("app.viewer.zoomIn")} onclick={() => (zoom = stepZoom(scale, 1))}><Glyph name="plus" size={10} /></button>
    <button class="tool" class:on={zoom === 0} title={t("app.viewer.fitTitle")} onclick={() => (zoom = 0)}>{t("app.viewer.fit")}</button>
    <button class="tool" class:on={zoom === 1} title={t("app.viewer.actualSize")} onclick={() => (zoom = 1)}>100 %</button>
  </div>
</div>

{#if broken}
  <div class="message" role="alert"><p>{t("app.viewer.brokenImage")}</p></div>
{:else}
  <div class="scroller" class:dragging bind:this={scroller} bind:clientWidth={boxW} bind:clientHeight={boxH} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} role="presentation">
    <div class="stage">
      {#if src}
        <img class="checker" bind:this={image} {src} alt={path.split("/").pop()} draggable="false" onload={onLoad} onerror={() => (broken = true)} style={natural ? `width: ${natural.w * scale}px; height: ${natural.h * scale}px` : "visibility: hidden"} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .toolbar { height: 44px; flex-shrink: 0; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid rgba(var(--fg-rgb), 0.05); }
  .info { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--label-2); font-variant-numeric: tabular-nums; }
  .spacer { flex: 1; }
  .tool { display: inline-grid; place-items: center; flex-shrink: 0; white-space: nowrap; height: 26px; min-width: 26px; padding: 0 10px; border-radius: 999px; color: var(--label-2); font-size: 11.5px; }
  .tool:hover { background: var(--fill-hover); color: var(--label); }
  .tool.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  .tool.round { width: 26px; padding: 0; }
  .zoom { display: flex; align-items: center; flex-shrink: 0; gap: 2px; padding: 2px; border-radius: 999px; background: var(--recess); box-shadow: var(--recess-shadow); }
  .pct { min-width: 46px; text-align: center; font-size: 11.5px; color: var(--label-2); font-variant-numeric: tabular-nums; }
  .scroller { flex: 1; min-height: 0; overflow: auto; }
  .scroller.dragging { cursor: grabbing; }
  .stage { box-sizing: border-box; min-width: 100%; min-height: 100%; width: max-content; padding: 16px; display: grid; place-items: center; }
  /* A fixed checkerboard: transparent images stay readable in every theme. */
  .checker { display: block; max-width: none; background: repeating-conic-gradient(#cfcfcf 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
  .message { margin: auto; max-width: 420px; padding: 16px; text-align: center; color: var(--label-2); }
  .message p { margin: 0; }
</style>
