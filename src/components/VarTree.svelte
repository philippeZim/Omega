<script lang="ts">
  import VarTree from "./VarTree.svelte";
  import type { VarNode } from "../lib/debug/store.svelte";
  import { toggleNode, setVariable, addWatch } from "../lib/debug/debugger.svelte";
  import { ui } from "../lib/ui.svelte";

  let { nodes, depth = 0 }: { nodes: VarNode[]; depth?: number } = $props();

  async function edit(n: VarNode) {
    const v = await ui.prompt(`${n.name} setzen`, n.value);
    if (v !== null) setVariable(n, v);
  }

  function menu(e: MouseEvent, n: VarNode) {
    ui.openMenu(e, [
      { label: "Wert ändern…", action: () => edit(n) },
      { label: "Als Watch hinzufügen", action: () => addWatch(n.evaluateName ?? n.name) },
      { label: "Wert kopieren", action: () => navigator.clipboard.writeText(n.value) },
    ]);
  }
</script>

{#each nodes as n, i (n.name + i)}
  <div class="row" style="padding-left: {6 + depth * 14}px" role="treeitem" tabindex="-1" aria-selected="false" aria-expanded={n.ref ? n.expanded : undefined}
    onclick={() => toggleNode(n)} onkeydown={() => {}} ondblclick={() => !n.ref && depth > 0 && edit(n)} oncontextmenu={(e) => depth > 0 && menu(e, n)}>
    {#if n.ref}
      <svg class="chev" class:open={n.expanded} width="9" height="9" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    {:else}
      <span class="sp"></span>
    {/if}
    {#if depth === 0}
      <span class="scope">{n.name}</span>
    {:else}
      <span class="name">{n.name}</span>
      {#if n.type}<span class="type">{n.type}</span>{/if}
      <span class="eq">=</span>
      <span class="value" class:changed={n.changed} title={n.value}>{n.value}</span>
    {/if}
  </div>
  {#if n.expanded && n.children}
    {#if n.children.length}
      <VarTree nodes={n.children} depth={depth + 1} />
    {:else}
      <div class="row empty" style="padding-left: {26 + depth * 14}px">leer</div>
    {/if}
  {/if}
{/each}

<style>
  .row { display: flex; align-items: center; gap: 6px; min-height: 24px; padding-right: 8px; border-radius: 8px; font-family: var(--mono); font-size: 12px; white-space: nowrap; overflow: hidden; }
  .row:hover { background: var(--fill-hover); }
  .chev { flex-shrink: 0; color: var(--label-3); transition: transform 0.12s; }
  .chev.open { transform: rotate(90deg); }
  .sp { width: 9px; flex-shrink: 0; }
  .scope { font-family: var(--font); font-weight: 600; font-size: 12px; color: var(--label-2); }
  .name { color: #a996cf; }
  .type { color: var(--label-3); font-size: 11px; }
  .eq { color: var(--label-3); }
  .value { color: var(--label); overflow: hidden; text-overflow: ellipsis; }
  .value.changed { color: var(--orange); }
  .empty { color: var(--label-3); font-family: var(--font); }
</style>
