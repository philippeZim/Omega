<script lang="ts">
  import { flushSync } from "svelte";
  import Glyph from "./Glyph.svelte";
  import { layout, visibleViews, activeView, zoneShown, isOverlay, setActive, setOpen, setSize, saveLayout, startDrag, noteFocus, drag, viewport, MIN_SIZE, type Zone, type ViewId } from "../lib/layout.svelte";
  import { t } from "../lib/i18n/index.svelte";
  import { git, refresh as gitRefresh } from "../lib/git/git.svelte";
  import { find } from "../lib/search/search.svelte";
  import FilesView from "./views/FilesView.svelte";
  import OutlineView from "./views/OutlineView.svelte";
  import TerminalView from "./views/TerminalView.svelte";
  import TerminalTabs from "./views/TerminalTabs.svelte";
  import ChangesPanel from "./ChangesPanel.svelte";
  import DebugPanel from "./DebugPanel.svelte";
  import DebugConsole from "./DebugConsole.svelte";
  import SearchDock from "./SearchDock.svelte";
  import PdfPanel from "./PdfPanel.svelte";

  let { zone }: { zone: Zone } = $props();

  const z = $derived(layout.zones[zone]);
  const views = $derived(visibleViews(zone));
  const active = $derived(activeView(zone));
  const shown = $derived(zoneShown(zone));
  const overlay = $derived(isOverlay(zone));
  const hasTerminal = $derived(z.views.includes("terminal"));

  function label(v: ViewId): string {
    switch (v) {
      case "files": return t("app.files");
      case "changes": return t("app.changes");
      case "outline": return t("app.outline");
      case "terminal": return t("commands.group.terminal");
      case "debug": return t("layout.debugger");
      case "console": return t("code.term.debugConsole");
      case "search": return find.docked ? t("code.term.search", { query: find.docked.query }) : t("commands.group.search");
      case "pdf": return "PDF";
    }
  }

  /** Icons for the compact tab strip; views without one keep their (truncating) label. */
  const ICONS: Partial<Record<ViewId, "folder" | "changes" | "outline">> = { files: "folder", changes: "changes", outline: "outline" };

  // Compact strip (#56): when the labels don't fit (narrow zone, long German/French words), inactive
  // tabs show only their icon (label in tooltip/aria-label) and the active tab shows icon + label.
  let head: HTMLElement | undefined = $state();
  let compact = $state(false);
  function measure() {
    if (!head) return;
    compact = false;
    flushSync();
    const labels = head.querySelectorAll<HTMLElement>(".switch .label");
    compact = [...labels].some((l) => l.scrollWidth > l.clientWidth + 1);
  }
  $effect(() => {
    if (!head) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(head);
    return () => ro.disconnect();
  });
  // Labels, tab set and count badge change the needed width without resizing the header; zone and
  // window size are tracked here too (ResizeObserver doesn't fire for windows that aren't painted).
  $effect(() => {
    views.map(label).join();
    void git.changes.length;
    void active;
    void z.size;
    void viewport.w;
    queueMicrotask(measure);
  });

  function pick(v: ViewId) {
    setActive(zone, v);
    if (v === "changes") gitRefresh();
  }

  /** 758 → "758", 1234 → "1.2k", 25000 → "25k" (exact number in the tooltip). */
  function compactCount(n: number): string {
    if (n < 1000) return String(n);
    return n < 10000 ? `${(Math.floor(n / 100) / 10).toString()}k` : `${Math.floor(n / 1000)}k`;
  }

  function startResize(e: PointerEvent) {
    e.preventDefault();
    const start = zone === "bottom" ? e.clientY : e.clientX, startSize = z.size;
    const max = zone === "bottom" ? innerHeight - 220 : innerWidth * 0.7;
    const move = (ev: PointerEvent) => {
      const pos = zone === "bottom" ? ev.clientY : ev.clientX;
      const delta = zone === "left" ? pos - start : start - pos;
      setSize(zone, Math.min(max, Math.max(MIN_SIZE[zone], startSize + delta)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dock-resizing");
      saveLayout();
    };
    document.body.classList.add("dock-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<section class="dock dock-{zone} glass" class:hidden={!shown} class:overlay data-zone={zone} onfocusin={noteFocus}
  style={zone === "bottom" ? `height: ${z.size}px` : overlay ? `width: min(${z.size}px, 100% - 48px)` : `width: ${z.size}px; min-width: ${MIN_SIZE[zone]}px`}>
  <div class="resizer" role="separator" onpointerdown={startResize}></div>
  <header class="head" bind:this={head}>
    <div class="switch" class:grow={active !== "terminal"} class:single={views.length === 1} class:compact data-drop-zone={zone} role="tablist">
      {#each views as v (v)}
        {@const icon = compact ? ICONS[v] : undefined}
        <button class="vt" class:on={v === active} class:iconic={icon && v !== active} class:dragging={drag.view === v} data-view-tab={v} role="tab" aria-selected={v === active}
          aria-label={label(v)} onpointerdown={(e) => startDrag(e, v)} onclick={() => pick(v)} title={label(v)}>
          {#if icon}<Glyph name={icon} size={12} stroke={1.3} />{/if}
          <span class="label">{label(v)}</span>
          {#if v === "changes" && git.changes.length}<span class="count" title={String(git.changes.length)}>{compactCount(git.changes.length)}</span>{/if}
          {#if v === "search"}
            <span class="x" role="button" tabindex="-1" aria-label={t("common.close")} onpointerdown={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); find.docked = null; }} onkeydown={() => {}}><Glyph name="x" size={7} /></span>
          {/if}
        </button>
      {/each}
    </div>
    {#if active === "terminal"}<TerminalTabs />{/if}
    {#if active === "terminal"}<span class="spacer"></span>{/if}
    <button class="hide" title={t("layout.hide")} aria-label={t("layout.hide")} onclick={() => setOpen(zone, false)}>
      <Glyph name="chevron-down" size={11} />
    </button>
  </header>
  <div class="content">
    <!-- The terminal stays mounted while hidden so its xterm DOM keeps its state. -->
    {#if hasTerminal}
      <div class="pane" class:hidden={active !== "terminal"} data-view="terminal"><TerminalView /></div>
    {/if}
    {#if active && active !== "terminal"}
      <div class="pane" data-view={active}>
        {#if active === "files"}<FilesView />
        {:else if active === "changes"}<ChangesPanel />
        {:else if active === "outline"}<OutlineView />
        {:else if active === "debug"}<DebugPanel />
        {:else if active === "console"}<DebugConsole />
        {:else if active === "search"}<SearchDock />
        {:else if active === "pdf"}<PdfPanel />
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .dock { position: relative; display: flex; flex-direction: column; min-height: 0; container: dock / inline-size; }
  /* Narrow zone with a single view: its name only costs room the terminal tabs need. */
  @container dock (max-width: 380px) {
    .switch.single:not(.grow) { display: none; }
  }
  .dock.hidden { display: none; }
  /* Side zones give way (down to their minimum) before the editor column disappears. */
  .dock-left, .dock-right { flex-shrink: 1; }
  /* In a low window the terminal gives way down to a usable minimum before the editor does. */
  .dock-bottom { flex-shrink: 1; min-height: 90px; }
  /* Narrow window: side zones float over the editor like a drawer. */
  .dock.overlay {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 30;
    background: var(--glass-strong);
    box-shadow: var(--glass-highlight), 0 24px 70px rgba(0, 0, 0, 0.7), 0 4px 14px rgba(0, 0, 0, 0.45);
    animation: dock-in 0.18s cubic-bezier(0.3, 0.9, 0.3, 1);
  }
  .dock-left.overlay { left: 0; }
  .dock-right.overlay { right: 0; }
  /* Opacity only: WebKitGTK flashes a stale frame when a transform animation ends. */
  @keyframes dock-in { from { opacity: 0; } }

  .resizer { position: absolute; z-index: 5; }
  .dock-left .resizer { right: -6px; top: 0; bottom: 0; width: 6px; cursor: col-resize; }
  .dock-right .resizer { left: -6px; top: 0; bottom: 0; width: 6px; cursor: col-resize; }
  .dock-bottom .resizer { top: -6px; left: 0; right: 0; height: 6px; cursor: row-resize; }

  .head { flex-shrink: 0; display: flex; align-items: center; gap: 6px; padding: 10px 10px 6px; min-width: 0; }
  .head > * { flex-shrink: 0; }
  .spacer { flex: 1; min-width: 0; }

  .switch { flex: 0 0 auto; max-width: 60%; min-width: 0; display: flex; padding: 3px; border-radius: 999px; background: var(--recess); box-shadow: var(--recess-shadow); }
  /* Without terminal tabs beside it the switch may use the whole header (the 60% cap only makes room for those). */
  .switch.grow { flex: 1 1 auto; max-width: none; }
  /* Tabs share the width but a longer one (label + count) may take more; labels truncate instead of overflowing. */
  .vt { flex: 1 1 auto; min-width: 0; height: 26px; padding: 0 10px; display: flex; align-items: center; justify-content: center; gap: 5px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--label-2); white-space: nowrap; cursor: default; touch-action: none; }
  .vt.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  .vt:not(.on):hover { color: var(--label); }
  .vt.dragging { opacity: 0.4; }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  /* Compact strip: icon-only tabs keep their natural (small) width, the active tab takes the rest. */
  .compact .vt:not(.on) { flex: 0 0 auto; }
  .vt.iconic { padding: 0 9px; }
  .vt.iconic .label { display: none; }
  .count { flex-shrink: 0; min-width: 16px; height: 16px; padding: 0 5px; display: grid; place-items: center; border-radius: 999px; font-size: 10px; line-height: 1; font-variant-numeric: tabular-nums; background: rgba(var(--fg-rgb), 0.14); }
  .x { flex-shrink: 0; width: 16px; height: 16px; margin-right: -4px; display: grid; place-items: center; border-radius: 50%; color: var(--label-2); }
  .x:hover { background: var(--fill-2); color: var(--label); }

  .hide { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--label-2); }
  .hide:hover { background: var(--fill-hover); color: var(--label); }
  .dock-left .hide :global(svg) { transform: rotate(90deg); }
  .dock-right .hide :global(svg) { transform: rotate(-90deg); }

  .content { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .pane { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; position: relative; }
  .pane.hidden { display: none; }
</style>
