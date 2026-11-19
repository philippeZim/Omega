<script lang="ts">
  import { app, activate, closeTab, newFile } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import RunBar from "./RunBar.svelte";

  function menu(e: MouseEvent, id: string, path: string | null) {
    ui.openMenu(e, [
      { label: "Schließen", shortcut: "Strg+W", action: () => closeTab(id) },
      { label: "Andere schließen", action: () => app.tabs.filter((t) => t.id !== id).forEach((t) => closeTab(t.id)) },
      ...(path ? [{ separator: true, label: "" }, { label: "Pfad kopieren", action: () => navigator.clipboard.writeText(path) }] : []),
    ]);
  }
</script>

{#if app.tabs.length || app.mode === "code"}
  <div class="tabs">
    {#each app.tabs as t (t.id)}
      <div
        class="tab"
        class:active={t.id === app.activeId}
        role="tab"
        tabindex="0"
        aria-selected={t.id === app.activeId}
        onclick={() => activate(t.id)}
        onkeydown={(e) => e.key === "Enter" && activate(t.id)}
        onauxclick={(e) => e.button === 1 && closeTab(t.id)}
        oncontextmenu={(e) => menu(e, t.id, t.path)}
        title={t.path ?? t.name}
      >
        <span class="name">{t.name}</span>
        <button class="close" class:dirty={t.dirty} onclick={(e) => { e.stopPropagation(); closeTab(t.id); }} aria-label="Schließen">
          <span class="x">×</span><span class="d"></span>
        </button>
      </div>
    {/each}
    <button class="add" onclick={newFile} title="Neue Datei (Strg+N)" aria-label="Neue Datei">+</button>
    {#if app.mode === "code"}<RunBar />{/if}
  </div>
{/if}

<style>
  .tabs {
    height: 50px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 10px;
    overflow-x: auto;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
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
  .tab.active { background: rgba(255, 255, 255, 0.1); color: var(--label); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .close .x { opacity: 0; grid-area: 1 / 1; }
  .tab:hover .close .x, .tab.active .close .x { opacity: 1; }
  .close .d { grid-area: 1 / 1; width: 7px; height: 7px; border-radius: 50%; background: var(--label-2); display: none; }
  .close.dirty .d { display: block; }
  .close.dirty .x { opacity: 0 !important; }
  .close.dirty:hover .d { display: none; }
  .close.dirty:hover .x { opacity: 1 !important; }
  .add {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    font-size: 17px;
    color: var(--label-2);
    flex-shrink: 0;
  }
  .add:hover { background: var(--fill-hover); color: var(--label); }
</style>
