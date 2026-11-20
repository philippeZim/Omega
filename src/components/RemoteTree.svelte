<script lang="ts">
  /** Guest view of the host's project tree (loaded lazily over the session). */
  import RemoteTree from "./RemoteTree.svelte";
  import { listRemote, openRemote, share } from "../lib/collab/share.svelte";
  import { activeTab } from "../lib/state.svelte";

  let { rel = "", depth = 0 }: { rel?: string; depth?: number } = $props();
  let entries = $state<{ name: string; rel: string; is_dir: boolean }[] | null>(null);
  let open = $state<Record<string, boolean>>({});

  $effect(() => {
    if (entries === null) listRemote(rel).then((e) => (entries = e));
  });

  const activeRel = $derived(activeTab()?.path?.startsWith("collab:") ? activeTab()!.path!.slice(7) : null);
  // Files other participants are in right now (coloured dots).
  const where = $derived.by(() => {
    const m: Record<string, string[]> = {};
    for (const p of Object.values(share.presence)) if (p.file) (m[p.file] ??= []).push(p.color);
    return m;
  });
</script>

{#if entries === null}
  <div class="loading" style="padding-left: {12 + depth * 14}px">…</div>
{:else}
  {#each entries as e (e.rel)}
    <button class="row" class:active={activeRel === e.rel} style="padding-left: {8 + depth * 14}px" onclick={() => (e.is_dir ? (open[e.rel] = !open[e.rel]) : openRemote(e.rel))}>
      {#if e.is_dir}
        <svg class="chev" class:open={open[e.rel]} width="10" height="10" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      {:else}
        <span class="sp"></span>
      {/if}
      <span class="name" class:dir={e.is_dir}>{e.name}</span>
      {#each where[e.rel] ?? [] as c, i (i)}<span class="who" style="background: {c}"></span>{/each}
    </button>
    {#if e.is_dir && open[e.rel]}
      <RemoteTree rel={e.rel} depth={depth + 1} />
    {/if}
  {/each}
{/if}

<style>
  .row { width: 100%; display: flex; align-items: center; gap: 6px; height: 30px; padding-right: 10px; border-radius: 10px; text-align: left; font-size: 13px; }
  .row:hover { background: var(--fill-hover); }
  .row.active { background: rgba(var(--fg-rgb), 0.1); }
  .chev { flex-shrink: 0; color: var(--label-2);  }
  .chev.open { transform: rotate(90deg); }
  .sp { width: 10px; flex-shrink: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name.dir { font-weight: 500; }
  .who { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .loading { color: var(--label-3); font-size: 12px; height: 26px; }
</style>
