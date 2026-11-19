<script lang="ts">
  import { onDestroy } from "svelte";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import * as pdfjs from "pdfjs-dist";
  import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
  import { latex, setDark, reverseSync, forwardSync } from "../lib/latex/controller.svelte";
  import { app, activeTab, openFile } from "../lib/state.svelte";
  import * as ed from "../lib/editor";

  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  let width = $state(Number(localStorage.getItem("pdfWidth")) || 560);
  let zoom = $state(Number(localStorage.getItem("pdfZoom")) || 0); // 0 = fit width
  let scroller: HTMLDivElement;
  let pagesEl = $state<HTMLDivElement>()!;
  let showLog = $state(false);
  let doc: pdfjs.PDFDocumentProxy | null = null;
  let pageSizes: { w: number; h: number }[] = [];
  let renderSeq = 0;
  let flash = $state<{ page: number; x: number; y: number; w: number; h: number } | null>(null);

  const errors = $derived(latex.diagnostics.filter((d) => d.severity === "error"));
  const warnings = $derived(latex.diagnostics.filter((d) => d.severity === "warning"));

  function scale(pageW: number) {
    if (zoom > 0) return zoom;
    return Math.max(0.3, (scroller.clientWidth - 32) / pageW);
  }

  async function load(path: string) {
    const seq = ++renderSeq;
    const url = convertFileSrc(path) + "?v=" + latex.pdfVersion;
    const next = await pdfjs.getDocument({ url, isEvalSupported: false }).promise.catch(() => null);
    if (!next || seq !== renderSeq) return;
    const old = doc;
    doc = next;
    await render(seq);
    old?.destroy();
  }

  async function render(seq = ++renderSeq) {
    if (!doc) return;
    const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    const dpr = window.devicePixelRatio || 1;
    const frag: HTMLElement[] = [];
    pageSizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      if (seq !== renderSeq) return;
      const base = page.getViewport({ scale: 1 });
      pageSizes.push({ w: base.width, h: base.height });
      const vp = page.getViewport({ scale: scale(base.width) });
      const wrap = document.createElement("div");
      wrap.className = "page";
      wrap.dataset.page = String(i);
      wrap.style.width = `${vp.width}px`;
      wrap.style.height = `${vp.height}px`;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      wrap.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      if (seq !== renderSeq) return;
      frag.push(wrap);
    }
    // Swap all pages at once to avoid flicker, then restore the scroll position.
    pagesEl.replaceChildren(...frag);
    scroller.scrollTop = ratio * scroller.scrollHeight;
  }

  $effect(() => {
    if (latex.pdf && latex.pdfVersion) load(latex.pdf);
  });

  $effect(() => {
    void zoom;
    localStorage.setItem("pdfZoom", String(zoom));
    if (doc) render();
  });

  // Forward sync: scroll to and flash the target box.
  $effect(() => {
    const t = latex.target;
    if (!t || !pageSizes[t.page - 1]) return;
    const pageEl = pagesEl.querySelector<HTMLElement>(`[data-page="${t.page}"]`);
    if (!pageEl) return;
    const s = pageEl.clientWidth / pageSizes[t.page - 1].w;
    scroller.scrollTo({ top: pageEl.offsetTop + t.y * s - scroller.clientHeight / 3, behavior: "smooth" });
    flash = { page: t.page, x: t.x * s, y: t.y * s, w: t.w * s, h: t.h * s };
    setTimeout(() => (flash = null), 1400);
  });

  async function onDblClick(e: MouseEvent) {
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".page");
    if (!pageEl) return;
    const page = Number(pageEl.dataset.page);
    const r = pageEl.getBoundingClientRect();
    const s = r.width / pageSizes[page - 1].w;
    const hit = reverseSync(page, (e.clientX - r.left) / s, (e.clientY - r.top) / s);
    if (!hit) return;
    if (hit.file && hit.file !== activeTab()?.path) await openFile(hit.file);
    gotoLine(hit.line);
  }

  function gotoLine(line: number) {
    const view = ed.getView();
    if (!view || line < 1) return;
    const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
    view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
    view.focus();
  }

  export function syncFromEditor() {
    const view = ed.getView();
    if (!view) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    forwardSync(activeTab()?.path ?? null, line);
  }

  function startResize(e: PointerEvent) {
    const startX = e.clientX, startW = width;
    const move = (ev: PointerEvent) => (width = Math.min(1400, Math.max(300, startW - (ev.clientX - startX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("pdfWidth", String(width));
      if (zoom === 0) render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  onDestroy(() => {
    renderSeq++;
    doc?.destroy();
  });
</script>


<aside class="pdf glass" style="width: {width}px">
  <div class="resizer" role="separator" onpointerdown={startResize}></div>
  <div class="toolbar">
    <button class="status {latex.status}" onclick={() => (showLog = !showLog)} title="Log / Fehler anzeigen">
      {#if latex.available === false}
        Tectonic fehlt
      {:else if latex.status === "compiling"}
        <span class="spinner"></span> Kompiliere…
      {:else if latex.status === "error"}
        {errors.length || 1} Fehler
      {:else if latex.status === "ok"}
        ✓ {(latex.millis / 1000).toFixed(1)} s{warnings.length ? ` · ${warnings.length} Warnungen` : ""}
      {:else}
        PDF
      {/if}
    </button>
    <span class="spacer"></span>
    <button class="tool" title="Zur Cursor-Position im PDF (Strg+J)" onclick={syncFromEditor}>⇥</button>
    <div class="zoom">
      <button class="tool" title="Verkleinern" onclick={() => (zoom = Math.max(0.4, (zoom || 1.2) - 0.15))}>−</button>
      <button class="tool fit" class:on={zoom === 0} title="Seitenbreite" onclick={() => (zoom = 0)}>Breite</button>
      <button class="tool" title="Vergrößern" onclick={() => (zoom = Math.min(4, (zoom || 1.2) + 0.15))}>+</button>
    </div>
    <button class="tool mode" class:on={latex.dark} title="Dunkles PDF ein/aus" onclick={() => setDark(!latex.dark)}>
      {latex.dark ? "Dunkel" : "Hell"}
    </button>
  </div>

  <div class="scroller" bind:this={scroller} ondblclick={onDblClick} role="document">
    {#if latex.available === false}
      <div class="empty">
        <h3>Tectonic ist nicht installiert</h3>
        <p>Führe im Terminal aus:</p>
        <code>sudo pacman -S tectonic</code>
      </div>
    {:else if !latex.pdf}
      <div class="empty"><p>{latex.status === "compiling" ? "Erstes Kompilieren… (Pakete werden beim ersten Mal geladen)" : "Noch kein PDF"}</p></div>
    {/if}
    <div class="pages" class:dark={latex.dark} bind:this={pagesEl}></div>
    {#if flash}
      {@const pageEl = pagesEl?.querySelector<HTMLElement>(`[data-page="${flash.page}"]`)}
      {#if pageEl}
        <div class="flash" style="left: {pageEl.offsetLeft + flash.x - 4}px; top: {pageEl.offsetTop + flash.y - 3}px; width: {flash.w + 8}px; height: {flash.h + 6}px"></div>
      {/if}
    {/if}
  </div>

  {#if showLog}
    <div class="log">
      <div class="log-head">
        <span>Fehler & Warnungen</span>
        <button class="tool" onclick={() => (showLog = false)}>×</button>
      </div>
      <div class="log-list">
        {#each latex.diagnostics as d, i (i)}
          <button class="diag {d.severity}" onclick={async () => { if (d.file && d.file !== activeTab()?.path && !d.file.endsWith("untitled.tex")) await openFile(d.file); gotoLine(d.line); }}>
            <span class="sev"></span>
            <span class="msg">{d.message}</span>
            {#if d.line}<span class="ln">Z. {d.line}</span>{/if}
          </button>
        {:else}
          <p class="none">Keine Meldungen.</p>
        {/each}
        <details>
          <summary>Vollständiges Log</summary>
          <pre>{latex.log}</pre>
        </details>
      </div>
    </div>
  {/if}
</aside>

<style>
  .pdf {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .resizer { position: absolute; left: 0; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
  .toolbar {
    height: 50px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }
  .spacer { flex: 1; }
  .status {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 14px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 12px;
    background: var(--recess);
    box-shadow: var(--recess-shadow);
    color: var(--label-2);
  }
  .status.ok { color: var(--green); }
  .status.error { color: var(--red); }
  .spinner {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 2px solid var(--label-3);
    border-top-color: var(--label);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tool {
    height: 30px;
    min-width: 30px;
    padding: 0 10px;
    border-radius: 999px;
    color: var(--label-2);
    font-size: 13px;
  }
  .tool:hover { background: var(--fill-hover); color: var(--label); }
  .tool.on { color: var(--label); background: rgba(255, 255, 255, 0.1); }
  .zoom { display: flex; align-items: center; border-radius: 999px; background: var(--recess); box-shadow: var(--recess-shadow); }
  .fit { font-size: 11.5px; }
  .mode { font-size: 11.5px; }
  .scroller { position: relative; flex: 1; overflow: auto; padding: 16px; }
  .pages { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .pages :global(.page) { position: relative; border-radius: 6px; overflow: hidden; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); background: white; }
  .pages :global(canvas) { width: 100%; height: 100%; display: block; }
  .pages.dark :global(canvas) { filter: invert(0.9) hue-rotate(180deg) brightness(1.05); }
  .pages.dark :global(.page) { background: #1a1a1a; }
  .flash {
    position: absolute;
    border-radius: 6px;
    background: rgba(216, 194, 122, 0.25);
    box-shadow: 0 0 0 2px rgba(216, 194, 122, 0.7);
    pointer-events: none;
    animation: fade 1.4s ease-out forwards;
  }
  @keyframes fade { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
  .empty { text-align: center; color: var(--label-2); padding-top: 80px; }
  .empty h3 { color: var(--label); margin: 0 0 8px; }
  .empty code { display: inline-block; margin-top: 6px; padding: 6px 14px; border-radius: 999px; background: var(--recess); font-family: var(--mono); color: var(--teal); user-select: text; }
  .log { max-height: 45%; display: flex; flex-direction: column; border-top: 1px solid rgba(255, 255, 255, 0.06); background: rgba(0, 0, 0, 0.25); }
  .log-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px 6px 16px; font-weight: 600; font-size: 12px; color: var(--label-2); }
  .log-list { overflow: auto; padding: 0 8px 10px; user-select: text; }
  .diag { width: 100%; display: flex; gap: 10px; align-items: baseline; padding: 6px 8px; border-radius: 10px; text-align: left; font-size: 12px; }
  .diag:hover { background: var(--fill-hover); }
  .sev { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; transform: translateY(-1px); }
  .diag.error .sev { background: var(--red); }
  .diag.warning .sev { background: var(--orange); }
  .msg { flex: 1; }
  .ln { color: var(--label-3); font-family: var(--mono); font-size: 11px; }
  .none { color: var(--label-3); font-size: 12px; padding: 4px 8px; }
  details { margin: 8px; color: var(--label-2); font-size: 12px; }
  pre { font-family: var(--mono); font-size: 11px; white-space: pre-wrap; color: var(--label-3); max-height: 300px; overflow: auto; }
</style>
