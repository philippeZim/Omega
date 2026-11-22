<script lang="ts">
  /** Guest view of the host's project tree (loaded lazily over the session). */
  import RemoteTree from "./RemoteTree.svelte";
  import { listRemote, openRemote, share, remoteCreate, remoteRename, remoteDelete } from "../lib/collab/share.svelte";
  import { ui } from "../lib/ui.svelte";
  import { activeTab } from "../lib/state.svelte";
  import { t } from "../lib/i18n/index.svelte";
  import { treeKeyAction, focusTreeRow } from "../lib/treeNav";

  let { rel = "", depth = 0 }: { rel?: string; depth?: number } = $props();
  let entries = $state<{ name: string; rel: string; is_dir: boolean }[] | null>(null);
  let open = $state<Record<string, boolean>>({});

  // Reload when the host's files change (share.treeGen) – keeps the open folders.
  $effect(() => {
    void share.treeGen;
    if (share.hostHasRoot) listRemote(rel).then((e) => (entries = e));
  });

  // Host tabs that aren't files in its folder ("Untitled", outside files) – or all tabs without a folder.
  const extraTabs = $derived(depth === 0 ? (share.hostHasRoot ? share.hostTabs.filter((x) => x.key.startsWith("tab:")) : share.hostTabs) : []);
  const activePath = $derived(activeTab()?.path ?? activeTab()?.viewOf);
  const activeRel = $derived(activePath?.startsWith("collab:") ? activePath.slice(7) : null);
  // Guests change the host's project like the host's own tree does (the host carries it out, #133).
  function menu(ev: MouseEvent, e: { rel: string; is_dir: boolean }) {
    ev.preventDefault();
    ui.openMenu(ev, [
      ...(e.is_dir
        ? [
            { label: t("app.newFile"), action: () => newIn(e.rel, false) },
            { label: t("app.newFolder"), action: () => newIn(e.rel, true) },
          ]
        : [{ label: t("common.open"), action: () => openRemote(e.rel) }]),
      { separator: true, label: "" },
      { label: t("common.rename"), action: () => remoteRename(e.rel) },
      { label: t("app.copyRelativePath"), action: () => navigator.clipboard.writeText(e.rel) },
      { separator: true, label: "" },
      { label: t("common.delete"), action: () => remoteDelete(e.rel), danger: true },
    ]);
  }
  async function newIn(dir: string, isDir: boolean) {
    open[dir] = true;
    await remoteCreate(dir, isDir);
  }

  // Same keys as the host's tree (#39). WebKit doesn't focus buttons on click.
  function onClick(ev: MouseEvent, e: { rel: string; is_dir: boolean }) {
    (ev.currentTarget as HTMLElement).focus({ preventScroll: true });
    if (e.is_dir) open[e.rel] = !open[e.rel];
    else openRemote(e.rel);
  }
  function onKey(ev: KeyboardEvent, e: { rel: string; is_dir: boolean }) {
    const a = treeKeyAction(ev, { isDir: e.is_dir, open: !!open[e.rel] });
    if (!a) return;
    ev.preventDefault();
    if (a === "expand" || a === "collapse") open[e.rel] = a === "expand";
    else if (a === "rename") remoteRename(e.rel);
    else if (a === "delete") remoteDelete(e.rel);
    else focusTreeRow(ev.currentTarget as HTMLElement, a);
  }

  // Files other participants are in right now (coloured dots).
  const where = $derived.by(() => {
    const m: Record<string, string[]> = {};
    for (const p of Object.values(share.presence)) if (p.file) (m[p.file] ??= []).push(p.color);
    return m;
  });
</script>

{#if extraTabs.length}
  <div class="section">{t("ai.collab.hostTabs")}</div>
  {#each extraTabs as tab (tab.key)}
    <button class="row" class:active={activeRel === tab.key} style="padding-left: 8px" onclick={() => openRemote(tab.key)}>
      <span class="sp"></span>
      <span class="name">{tab.name}</span>
      {#each where[tab.key] ?? [] as c, i (i)}<span class="who" style="background: {c}"></span>{/each}
    </button>
  {/each}
{/if}
{#if !share.hostHasRoot}
  <!-- nothing else to show -->
{:else if entries === null}
  <div class="loading" style="padding-left: {12 + depth * 14}px">…</div>
{:else}
  {#each entries as e (e.rel)}
    <button class="row" class:active={activeRel === e.rel} style="padding-left: {8 + depth * 14}px" role="treeitem" aria-level={depth + 1} aria-selected={activeRel === e.rel} aria-expanded={e.is_dir ? !!open[e.rel] : undefined} onclick={(ev) => onClick(ev, e)} onkeydown={(ev) => onKey(ev, e)} oncontextmenu={(ev) => menu(ev, e)}>
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
  .section { padding: 6px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--label-3); }
</style>
