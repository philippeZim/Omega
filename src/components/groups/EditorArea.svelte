<script lang="ts">
  import SplitNode from "./SplitNode.svelte";
  import { app } from "../../lib/state.svelte";
  import { tabDrag } from "../../lib/tabDrag.svelte";
</script>

<!-- The editor groups (#219); one group without any split. -->
<div class="area">
  <SplitNode node={app.groups.root} />
</div>

{#if tabDrag.id}
  <!-- Appears instantly, no transitions (WebKitGTK flashes faded layers over glass). -->
  {#if tabDrag.target}
    {@const p = tabDrag.target.preview}
    {#if tabDrag.target.line}
      {@const l = tabDrag.target.line}
      <div class="line" style:left="{l.x - 1}px" style:top="{l.y}px" style:height="{l.h}px"></div>
    {:else}
      <div class="drop" style:left="{p.x}px" style:top="{p.y}px" style:width="{p.w}px" style:height="{p.h}px"></div>
    {/if}
  {/if}
  <div class="ghost" style:left="{tabDrag.x + 12}px" style:top="{tabDrag.y + 10}px">{tabDrag.name}</div>
{/if}

<style>
  :global(body.tab-dragging), :global(body.tab-dragging *) { cursor: grabbing !important; user-select: none !important; }
  .area { flex: 1; min-height: 120px; min-width: 0; display: flex; }
  .drop { position: fixed; z-index: 900; pointer-events: none; border-radius: 14px; background: var(--accent-soft); border: 1.5px solid var(--accent); }
  .line { position: fixed; z-index: 900; pointer-events: none; width: 2px; border-radius: 1px; background: var(--accent); }
  .ghost {
    position: fixed;
    z-index: 901;
    pointer-events: none;
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--label);
    background: var(--bg-elevated, var(--fill-2));
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    white-space: nowrap;
  }
</style>
