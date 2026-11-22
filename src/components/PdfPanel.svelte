<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { onDestroy } from "svelte";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { openUrl } from "../lib/native";
  import * as pdfjs from "pdfjs-dist";
  import { PDF_LOAD_OPTIONS, pdfWorker, type PageLink } from "../lib/pdfPages";
  import { PdfPager } from "../lib/pdfPager";
  import { latex, setDark, reverseSync, forwardSync, installLatex, remoteLatex, remotePdfBytes, compileNow } from "../lib/latex/controller.svelte";
  import { app, activeTab, openFile } from "../lib/state.svelte";
  import * as ed from "../lib/editor";
  import { t } from "../lib/i18n/index.svelte";

  let zoom = $state(Number(localStorage.getItem("pdfZoom")) || 0); // 0 = fit width
  let scroller: HTMLDivElement;
  let pagesEl = $state<HTMLDivElement>()!;
  let showLog = $state(false);
  let pager: PdfPager | null = null;
  let renderSeq = 0;
  let flash = $state<{ left: number; top: number; w: number; h: number } | null>(null);
  let flashTimer = 0;

  const errors = $derived(latex.diagnostics.filter((d) => d.severity === "error"));
  const warnings = $derived(latex.diagnostics.filter((d) => d.severity === "warning"));

  function getPager() {
    pager ??= new PdfPager({ scroller, pages: pagesEl, zoom: () => zoom, openLink });
    return pager;
  }

  function openLink(link: PageLink) {
    if (link.url) void openUrl(link.url);
    else if (link.dest) void pager?.gotoDest(link.dest, true);
  }

  /** A recompile keeps the view: pages show their old bitmap until the new one is ready. */
  async function load(path: string) {
    const seq = ++renderSeq;
    const data = remotePdfBytes();
    const source = data ? { data } : { url: convertFileSrc(path) + "?v=" + latex.pdfVersion };
    const next = await pdfjs.getDocument({ ...source, ...PDF_LOAD_OPTIONS, worker: pdfWorker() }).promise.catch(() => null);
    if (!next) return;
    if (seq !== renderSeq) return void next.destroy();
    const first = await next.getPage(1).catch(() => null);
    if (!first || seq !== renderSeq) return void next.destroy();
    void getPager().attach(next, first)?.destroy();
  }

  /** Drops the rendered pages (e.g. after switching to a .tex tab without a PDF). */
  function clear() {
    renderSeq++;
    void pager?.clear()?.destroy();
  }

  $effect(() => {
    if (!latex.pdf) clear();
    else if (latex.pdfVersion) load(latex.pdf);
  });

  $effect(() => {
    void zoom;
    localStorage.setItem("pdfZoom", String(zoom));
    pager?.relayout();
  });

  // Forward sync: scroll to and flash the target box, also on a page that isn't mounted.
  async function reveal(tg: NonNullable<typeof latex.target>) {
    const p = pager;
    if (!p || !(await p.ensureSize(tg.page - 1)) || latex.target !== tg) return;
    const b = p.pageBox(tg.page - 1);
    p.scrollToDoc(b.docTop + tg.y * b.scale - scroller.clientHeight / 3, true);
    flash = { left: b.left + tg.x * b.scale - 4, top: b.top + tg.y * b.scale - 3, w: tg.w * b.scale + 8, h: tg.h * b.scale + 6 };
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => (flash = null), 1400);
  }

  $effect(() => {
    const tg = latex.target;
    if (tg) void reveal(tg);
  });

  async function onDblClick(e: MouseEvent) {
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".page");
    if (!pageEl || !pager) return;
    const page = Number(pageEl.dataset.page);
    const r = pageEl.getBoundingClientRect();
    const { clientX, clientY } = e;
    if (!(await pager.ensureSize(page - 1))) return;
    const s = r.width / pager.pageBox(page - 1).width;
    const hit = reverseSync(page, (clientX - r.left) / s, (clientY - r.top) / s);
    if (!hit) return;
    await openAt(hit.file, hit.line);
  }

  /** A diagnostic from another file than the active one (e.g. an \input chapter). */
  const otherFile = (file: string) => !!file && file !== activeTab()?.path && !file.endsWith("untitled.tex");
  /** Path relative to the project folder, else the file name. */
  const shortName = (file: string) => (file.startsWith("collab:") ? file.slice(7) : app.root && file.startsWith(app.root + "/") ? file.slice(app.root.length + 1) : file.split("/").pop());

  /** Opens `file` (if it isn't the active tab) and jumps to `line` there; nothing if it failed to open. */
  async function openAt(file: string, line: number) {
    if (otherFile(file)) {
      if (file.startsWith("collab:")) return remoteLatex.openAt(file, line); // opens asynchronously
      await openFile(file, false, true);
      if (activeTab()?.path !== file) return;
    }
    gotoLine(line);
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

  // Fit-width zoom follows the panel width (dock zone resized or moved), debounced.
  let rootEl = $state<HTMLDivElement>();
  $effect(() => {
    if (!rootEl) return;
    let last = rootEl.clientWidth, timer = 0;
    const ro = new ResizeObserver(() => {
      if (!rootEl || rootEl.clientWidth === last) return;
      last = rootEl.clientWidth;
      clearTimeout(timer);
      timer = window.setTimeout(() => zoom === 0 && pager?.relayout(), 150);
    });
    ro.observe(rootEl);
    return () => { ro.disconnect(); clearTimeout(timer); };
  });

  onDestroy(() => {
    renderSeq++;
    clearTimeout(flashTimer);
    void pager?.clear()?.destroy();
  });
</script>


<div class="pdf" bind:this={rootEl}>
  <div class="toolbar">
    <button class="status {latex.status}" onclick={() => (showLog = !showLog)} title={t("code.pdf.showLog")}>
      {#if latex.available === false}
        {t("code.pdf.tectonicMissing")}
      {:else if latex.status === "compiling"}
        <span class="spinner"></span> {latex.progress ? `${t(`code.pdf.phase.${latex.progress.phase}`)} ${Math.round(latex.progress.percent)} %` : t("code.pdf.compiling")}
      {:else if latex.status === "error"}
        {errors.length > 1 ? t("code.pdf.errors", { n: errors.length }) : t("code.pdf.error1")}
      {:else if latex.status === "ok"}
        ✓ {(latex.millis / 1000).toFixed(1)} s{warnings.length ? ` · ${warnings.length > 1 ? t("code.pdf.warnings", { n: warnings.length }) : t("code.pdf.warning1")}` : ""}
      {:else}
        PDF
      {/if}
    </button>
    <span class="spacer"></span>
    <button class="tool icon" title={t("code.pdf.syncToCursor")} aria-label={t("code.pdf.syncToCursor")} onclick={syncFromEditor}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.25" /><circle cx="7" cy="7" r="1.1" fill="currentColor" stroke="none" /><path d="M7 .75v1.5M7 11.75v1.5M.75 7h1.5M11.75 7h1.5" /></svg>
    </button>
    <div class="zoom">
      <button class="tool" title={t("code.pdf.zoomOut")} onclick={() => (zoom = Math.max(0.4, (zoom || 1.2) - 0.15))}><Glyph name="minus" size={10} /></button>
      <button class="tool fit" class:on={zoom === 0} title={t("code.pdf.fitWidth")} onclick={() => (zoom = 0)}>{t("code.pdf.width")}</button>
      <button class="tool" title={t("code.pdf.zoomIn")} onclick={() => (zoom = Math.min(4, (zoom || 1.2) + 0.15))}><Glyph name="plus" size={10} /></button>
    </div>
    <button class="tool icon" class:on={latex.dark} title="{t('code.pdf.toggleDark')} · {latex.dark ? t('code.pdf.dark') : t('code.pdf.light')}" aria-label={t("code.pdf.toggleDark")} onclick={() => setDark(!latex.dark)}>
      {#if latex.dark}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M11.9 8.6A5.25 5.25 0 0 1 5.4 2.1a5.25 5.25 0 1 0 6.5 6.5Z" /></svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="2.6" /><path d="M7 .9v1.4M7 11.7v1.4M.9 7h1.4M11.7 7h1.4M2.7 2.7l1 1M10.3 10.3l1 1M2.7 11.3l1-1M10.3 3.7l1-1" /></svg>
      {/if}
    </button>
  </div>

  {#if latex.pausedBy !== null}
    <div class="paused" role="status">
      <span>{t(latex.guestInRun ? "ai.collab.latex.hostPausedInRun" : "ai.collab.latex.hostPaused", { name: latex.pausedBy })}</span>
      <button onclick={compileNow}>{t("ai.collab.latex.compile")}</button>
    </div>
  {/if}
  {#if latex.progress && latex.pdf}
    <div class="topbar-progress" title={t(`code.pdf.phase.${latex.progress.phase}`)}><div class="fill" style="width: {latex.progress.percent}%"></div></div>
  {/if}
  <div class="scroller" bind:this={scroller} onscroll={() => pager?.sync()} ondblclick={onDblClick} role="document">
    {#if latex.available === false}
      <div class="empty">
        <h3>{t("code.pdf.notInstalled")}</h3>
        <button class="install" onclick={installLatex}>{t("tools.installLatex")}</button>
      </div>
    {:else if !latex.pdf}
      {#if latex.progress}
        {@const pr = latex.progress}
        <div class="progress-card">
          <div class="pc-head">
            <span>{t(`code.pdf.phase.${pr.phase}`)}</span>
            <span class="pc-pct">{Math.round(pr.percent)} %</span>
          </div>
          <div class="bar"><div class="fill" style="width: {pr.percent}%"></div></div>
          <div class="pc-sub">
            {#if pr.downloads}{t("code.pdf.downloaded", { n: pr.downloads })}{/if}
            {#if pr.file}<span class="pc-file">· {pr.file}</span>{/if}
          </div>
          <p class="pc-hint">{t("code.pdf.firstCompile")}</p>
        </div>
      {:else}
        <div class="empty"><p>{latex.status === "compiling" ? t("code.pdf.firstCompile") : t("code.pdf.noPdf")}</p></div>
      {/if}
    {/if}
    <div class="pages" class:dark={latex.dark} bind:this={pagesEl}></div>
    {#if flash}
      <div class="flash" style="left: {flash.left}px; top: {flash.top}px; width: {flash.w}px; height: {flash.h}px"></div>
    {/if}
  </div>

  {#if showLog}
    <div class="log">
      <div class="log-head">
        <span>{t("code.pdf.problems")}</span>
        <button class="tool" onclick={() => (showLog = false)} aria-label={t("common.close")}><Glyph name="x" size={8} /></button>
      </div>
      <div class="log-list">
        {#each latex.diagnostics as d, i (i)}
          <button class="diag {d.severity}" onclick={() => openAt(d.file, d.line)}>
            <span class="sev"></span>
            <span class="msg">{d.message}</span>
            {#if otherFile(d.file)}<span class="ln file" title={d.file}>{shortName(d.file)}</span>{/if}
            {#if d.line}<span class="ln">{t("code.pdf.line", { n: d.line })}</span>{/if}
          </button>
        {:else}
          <p class="none">{t("code.pdf.noMessages")}</p>
        {/each}
        <details>
          <summary>{t("code.pdf.fullLog")}</summary>
          <pre>{latex.log}</pre>
        </details>
      </div>
    </div>
  {/if}
</div>

<style>
  .pdf {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .toolbar {
    height: 50px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border-bottom: 1px solid rgba(var(--fg-rgb), 0.05);
  }
  .spacer { flex: 1; }
  .status {
    display: flex;
    align-items: center;
    min-width: 0;
    flex-shrink: 1;
    overflow: hidden;
    white-space: nowrap;
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
    flex-shrink: 0;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 2px solid var(--label-3);
    border-top-color: var(--label);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    0%, 100% { border-color: var(--label) var(--label-3) var(--label-3) var(--label-3); }
    25% { border-color: var(--label-3) var(--label) var(--label-3) var(--label-3); }
    50% { border-color: var(--label-3) var(--label-3) var(--label) var(--label-3); }
    75% { border-color: var(--label-3) var(--label-3) var(--label-3) var(--label); }
  }
  .tool {
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
    white-space: nowrap;
    height: 30px;
    min-width: 30px;
    padding: 0 10px;
    border-radius: 999px;
    color: var(--label-2);
    font-size: 13px;
  }
  .tool:hover { background: var(--fill-hover); color: var(--label); }
  .tool.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  .tool.icon { width: 30px; padding: 0; }
  .zoom { display: flex; align-items: center; flex-shrink: 0; gap: 2px; padding: 2px; border-radius: 999px; background: var(--recess); box-shadow: var(--recess-shadow); }
  .zoom .tool { height: 26px; min-width: 26px; }
  .zoom .tool:not(.fit) { width: 26px; padding: 0; }
  .fit { font-size: 11.5px; }
  .scroller { position: relative; flex: 1; overflow: auto; }
  .pages { position: relative; }
  .pages :global(.slot) { position: absolute; }
  .pages :global(.page) { position: relative; width: 100%; height: 100%; border-radius: 6px; overflow: hidden; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); background: white; }
  .pages :global(canvas) { width: 100%; height: 100%; display: block; }
  .pages :global(.link) { position: absolute; border-radius: 3px; cursor: pointer; }
  .pages :global(.link:hover) { background: rgba(52, 120, 246, 0.14); box-shadow: 0 0 0 1px rgba(52, 120, 246, 0.35); }
  .pages.dark :global(canvas) { filter: invert(0.9) hue-rotate(180deg) brightness(1.05); }
  .pages.dark :global(.page) { background: #1a1a1a; }
  .flash {
    position: absolute;
    border-radius: 6px;
    background: rgba(216, 194, 122, 0.25);
    box-shadow: 0 0 0 2px rgba(216, 194, 122, 0.7);
    pointer-events: none;
    /* Fades colours, not opacity: an opacity animation inside the glass panel flashes in WebKitGTK. */
    animation: flash-fade 1.4s ease-out forwards;
  }
  @keyframes flash-fade { 0%, 60% { background: rgba(216, 194, 122, 0.25); box-shadow: 0 0 0 2px rgba(216, 194, 122, 0.7); } 100% { background: transparent; box-shadow: 0 0 0 2px transparent; } }
  .empty { text-align: center; color: var(--label-2); padding: 96px 16px 0; }
  .progress-card { box-sizing: border-box; width: calc(100% - 32px); max-width: 340px; margin: 86px auto 0; padding: 16px 18px; border-radius: 18px; background: var(--fill-hover); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.05); }
  .pc-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-weight: 600; color: var(--label); }
  .pc-pct { font-size: 12px; font-weight: 500; color: var(--label-2); font-variant-numeric: tabular-nums; }
  .bar { height: 6px; margin: 12px 0 8px; border-radius: 999px; background: var(--recess); box-shadow: var(--recess-shadow); overflow: hidden; }
  .bar .fill, .topbar-progress .fill { position: relative; height: 100%; border-radius: inherit; background: var(--accent); transition: width 0.35s ease; overflow: hidden; }
  /* Moving sheen so the bar visibly lives even when a single step takes long. */
  .bar .fill::after, .topbar-progress .fill::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent) no-repeat; background-size: 50% 100%; background-position: -100% 0; animation: sheen 1.4s ease-in-out infinite; }
  @keyframes sheen { to { background-position: 200% 0; } }
  .pc-sub { min-height: 16px; display: flex; gap: 5px; font-size: 11.5px; color: var(--label-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pc-file { overflow: hidden; text-overflow: ellipsis; color: var(--label-3); font-family: var(--mono); font-size: 11px; }
  .pc-hint { margin: 10px 0 0; font-size: 11.5px; color: var(--label-3); }
  .paused { display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px 16px; flex-shrink: 0; font-size: 12px; color: var(--label-2); background: var(--well); border-bottom: 1px solid rgba(var(--fg-rgb), 0.06); }
  .paused span { flex: 1; min-width: 0; }
  .paused button { flex-shrink: 0; padding: 5px 12px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; }
  .topbar-progress { height: 2px; flex-shrink: 0; background: transparent; }
  @media (prefers-reduced-motion: reduce) { .bar .fill::after, .topbar-progress .fill::after { animation: none; } }
  .empty h3 { color: var(--label); margin: 0 0 8px; }
  .empty .install { margin-top: 10px; padding: 7px 16px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; }
  .log { max-height: 45%; display: flex; flex-direction: column; border-top: 1px solid rgba(var(--fg-rgb), 0.06); background: var(--well); }
  .log-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px 6px 16px; font-weight: 600; font-size: 12px; color: var(--label-2); }
  .log-list { overflow: auto; padding: 0 8px 10px; user-select: text; }
  .diag { width: 100%; display: flex; gap: 10px; align-items: baseline; padding: 6px 8px; border-radius: 10px; text-align: left; font-size: 12px; }
  .diag:hover { background: var(--fill-hover); }
  .sev { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; transform: translateY(-1px); }
  .diag.error .sev { background: var(--red); }
  .diag.warning .sev { background: var(--orange); }
  .msg { flex: 1; }
  .ln { color: var(--label-3); font-family: var(--mono); font-size: 11px; }
  .ln.file { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .none { color: var(--label-3); font-size: 12px; padding: 4px 8px; }
  details { margin: 8px; color: var(--label-2); font-size: 12px; }
  pre { font-family: var(--mono); font-size: 11px; white-space: pre-wrap; color: var(--label-3); max-height: 300px; overflow: auto; }
</style>
