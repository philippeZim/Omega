<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { app, activate, closeTab, newFile, foreignProject } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import RunBar from "./RunBar.svelte";
  import { t } from "../lib/i18n/index.svelte";
  import { tabHints } from "../lib/tabHints";

  function menu(e: MouseEvent, id: string, path: string | null) {
    ui.openMenu(e, [
      { label: t("common.close"), shortcut: `${t("app.ctrl")}+W`, action: () => closeTab(id) },
      { label: t("app.closeOthers"), action: () => app.tabs.filter((x) => x.id !== id).forEach((x) => closeTab(x.id)) },
      ...(app.tabs.some((x) => foreignProject(x))
        ? [{ label: t("app.closeForeign"), action: () => app.tabs.filter((x) => foreignProject(x)).forEach((x) => closeTab(x.id)) }]
        : []),
      ...(path ? [{ separator: true, label: "" }, { label: t("app.copyPath"), action: () => navigator.clipboard.writeText(path) }] : []),
    ]);
  }

  let width = $state(1000);
  // Parent folders that tell tabs with the same file name apart (#38).
  const hints = $derived(tabHints(app.tabs));
</script>

{#if app.tabs.length || app.mode === "code"}
  <div class="tabbar" bind:clientWidth={width}>
  <div class="tabs">
    {#each app.tabs as tab, i (tab.id)}
      {@const foreign = foreignProject(tab)}
      <div
        class="tab"
        class:active={tab.id === app.activeId}
        class:foreign={!!foreign}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === app.activeId}
        onclick={() => activate(tab.id)}
        onkeydown={(e) => e.key === "Enter" && activate(tab.id)}
        onauxclick={(e) => e.button === 1 && closeTab(tab.id)}
        oncontextmenu={(e) => menu(e, tab.id, tab.path)}
        title={foreign ? `${tab.path}\n${t("app.foreignTab", { project: foreign })}` : (tab.path ?? tab.name)}
      >
        {#if foreign}<span class="proj">{foreign}</span>{/if}
        <span class="name">{tab.name}</span>
        {#if hints[i]}<span class="hint">{hints[i]}</span>{/if}
        <button class="close" class:dirty={tab.dirty} onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }} aria-label={t("common.close")}>
          <span class="x"><Glyph name="x" size={8} /></span><span class="d"></span>
        </button>
      </div>
    {/each}
    <button class="add" onclick={newFile} title="{t('app.newFile')} ({t('app.ctrl')}+N)" aria-label={t("app.newFile")}><Glyph name="plus" size={11} /></button>
  </div>
  {#if app.mode === "code"}<RunBar {width} />{/if}
  </div>
{/if}

<style>
  .tabbar {
    height: 50px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding-right: 10px;
    border-bottom: 1px solid rgba(var(--fg-rgb), 0.05);
  }
  /* Only the tabs scroll; the run bar stays pinned on the right. */
  .tabs {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 10px;
    overflow-x: auto;
  }
  .tabs::-webkit-scrollbar { height: 0; }
  .tab {
    height: 32px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 7px 0 14px;
    border-radius: 999px;
    color: var(--label-2);
    flex-shrink: 0;
    max-width: 220px;
    transition: background 0.12s, color 0.12s;
  }
  .tab:hover { background: var(--fill-hover); color: var(--label); }
  .tab.active { background: rgba(var(--fg-rgb), 0.1); color: var(--label); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.08); }
  /* Tabs whose file isn't part of the open project (left over from a previous folder). */
  .tab.foreign { padding-left: 5px; border: 1px dashed rgba(var(--fg-rgb), 0.16); }
  .tab.foreign .name { font-style: italic; opacity: 0.7; }
  .tab.foreign.active .name, .tab.foreign:hover .name { opacity: 0.9; }
  .proj {
    flex-shrink: 1;
    min-width: 0;
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 10.5px;
    color: var(--label-2);
    background: rgba(var(--fg-rgb), 0.08);
  }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint {
    flex-shrink: 1;
    min-width: 0;
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    opacity: 0.55;
  }
  .close {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 15px;
    line-height: 1;
    color: var(--label-2);
  }
  .close:hover { background: var(--fill-2); color: var(--label); }
  .close .x { opacity: 0; grid-area: 1 / 1; display: grid; place-items: center; }
  .tab:hover .close .x, .tab.active .close .x { opacity: 1; }
  .close .d { grid-area: 1 / 1; width: 7px; height: 7px; border-radius: 50%; background: var(--label-2); display: none; }
  .close.dirty .d { display: block; }
  .close.dirty .x { opacity: 0 !important; }
  .close.dirty:hover .d { display: none; }
  .close.dirty:hover .x { opacity: 1 !important; }
  .add {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--label-2);
    flex-shrink: 0;
  }
  .add:hover { background: var(--fill-hover); color: var(--label); }
</style>
