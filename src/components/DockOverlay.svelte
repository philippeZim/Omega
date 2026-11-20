<script lang="ts">
  import { drag } from "../lib/layout.svelte";
  import { t } from "../lib/i18n/index.svelte";

  const NAMES: Record<string, () => string> = {
    files: () => t("app.files"),
    changes: () => t("app.changes"),
    outline: () => t("app.outline"),
    terminal: () => t("commands.group.terminal"),
    debug: () => t("layout.debugger"),
    console: () => t("code.term.debugConsole"),
    search: () => t("commands.group.search"),
    pdf: () => "PDF",
  };
</script>

{#if drag.view}
  <div class="overlay">
    {#if drag.target}
      {@const p = drag.target.preview}
      <div class="preview" style="left: {p.x}px; top: {p.y}px; width: {p.w}px; height: {p.h}px"></div>
      {#if drag.target.line}
        {@const l = drag.target.line}
        <div class="line" style="left: {l.x - 1}px; top: {l.y}px; height: {l.h}px"></div>
      {/if}
    {/if}
    <div class="ghost" style="left: {drag.x + 12}px; top: {drag.y + 10}px">{NAMES[drag.view]?.()}</div>
  </div>
{/if}

<style>
  .overlay { position: fixed; inset: 0; z-index: 900; pointer-events: none; }
  .preview { position: fixed; border-radius: var(--radius-l, 22px); background: var(--accent-soft); box-shadow: inset 0 0 0 2px var(--accent); transition: left 0.12s, top 0.12s, width 0.12s, height 0.12s; }
  .line { position: fixed; width: 3px; border-radius: 2px; background: var(--accent); }
  .ghost { position: fixed; padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow), 0 8px 24px rgba(0, 0, 0, 0.35); white-space: nowrap; }
  :global(body.dock-dragging), :global(body.dock-dragging *) { cursor: grabbing !important; user-select: none !important; }
  :global(body.dock-resizing) { user-select: none; }
</style>
