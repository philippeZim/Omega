<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { app, activateIn, closeInGroup, newFileInSession, foreignProject, focusGroup, groupMode, groupCount, setMode, splitGroup, joinGroups, type Tab } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import RunBar from "./RunBar.svelte";
  import LangPicker from "./LangPicker.svelte";
  import { t } from "../lib/i18n/index.svelte";
  import { shortcutLabel, withShortcut } from "../lib/commands.svelte";
  import { tabHints } from "../lib/tabHints";
  import { MODES } from "../lib/modeList";
  import { consumeDrop, pressTab, tabDrag } from "../lib/tabDrag.svelte";
  import { tick } from "svelte";

  let { gid }: { gid: string } = $props();

  const group = $derived(app.groups.groups[gid]);
  const tabs = $derived((group?.tabs ?? []).map((id) => app.tabs.find((x) => x.id === id)).filter((x): x is Tab => !!x));
  const split = $derived(groupCount() > 1);
  const mode = $derived(gid === app.groups.focused ? app.mode : (groupMode(gid) ?? app.mode));
  const activeHere = $derived(tabs.find((x) => x.id === group?.active) ?? null);

  const close = (id: string) => closeInGroup(gid, id);

  function menu(e: MouseEvent, id: string, path: string | null) {
    ui.openMenu(e, [
      { label: t("common.close"), shortcut: shortcutLabel("tab.close"), action: () => close(id) },
      { label: t("app.closeOthers"), action: () => tabs.filter((x) => x.id !== id).forEach((x) => close(x.id)) },
      ...(tabs.some((x) => foreignProject(x))
        ? [{ label: t("app.closeForeign"), action: () => tabs.filter((x) => foreignProject(x)).forEach((x) => close(x.id)) }]
        : []),
      { separator: true, label: "" },
      { label: t("app.splitRight"), shortcut: shortcutLabel("group.splitRight"), action: () => splitGroup("right", gid, id) },
      { label: t("app.splitDown"), shortcut: shortcutLabel("group.splitDown"), action: () => splitGroup("down", gid, id) },
      ...(split ? [{ label: t("app.joinGroups"), action: joinGroups }] : []),
      ...(path ? [{ separator: true, label: "" }, { label: t("app.copyPath"), action: () => navigator.clipboard.writeText(path) }] : []),
    ]);
  }

  /** The mode chip of a group (only with several groups): picks the mode of the file shown here. */
  function modeMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ui.openMenu(new MouseEvent("contextmenu", { clientX: r.left, clientY: r.bottom + 8 }), MODES.map((m) => ({
      label: (m.id === mode ? "✓  " : "     ") + m.label,
      shortcut: shortcutLabel(`mode.${m.id}`),
      action: () => {
        focusGroup(gid);
        setMode(m.id);
      },
    })));
  }

  function click(id: string) {
    if (consumeDrop()) return;
    activateIn(gid, id);
  }

  let width = $state(1000);
  // Parent folders that tell tabs with the same file name apart (#38).
  const hints = $derived(tabHints(tabs));

  // Keep the active tab visible when the tabs overflow (#117).
  let tabsEl = $state<HTMLElement | null>(null);
  $effect(() => {
    void group?.active;
    void tabs.length;
    tick().then(() => tabsEl?.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  });
</script>

{#if tabs.length || mode === "code" || split}
  <div class="tabbar" bind:clientWidth={width}>
  {#if split && activeHere && !activeHere.viewOf && width >= 260}
    <button class="modechip" onclick={modeMenu} title={t("app.groupMode", { mode: MODES.find((m) => m.id === mode)?.label ?? "" })} aria-haspopup="menu">
      {MODES.find((m) => m.id === mode)?.label}
    </button>
  {/if}
  <div class="tabs" bind:this={tabsEl}>
    {#each tabs as tab, i (tab.id)}
      {@const foreign = foreignProject(tab)}
      <div
        class="tab"
        class:active={tab.id === group?.active}
        class:foreign={!!foreign}
        class:dragging={tabDrag.id === tab.id && tabDrag.from === gid}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === group?.active}
        onpointerdown={(e) => pressTab(e, tab.id, gid, tab.name)}
        onclick={() => click(tab.id)}
        onkeydown={(e) => e.key === "Enter" && activateIn(gid, tab.id)}
        onauxclick={(e) => e.button === 1 && close(tab.id)}
        oncontextmenu={(e) => menu(e, tab.id, tab.path)}
        title={foreign ? `${tab.path}\n${t("app.foreignTab", { project: foreign })}` : (tab.path ?? tab.name)}
      >
        {#if foreign}<span class="proj">{foreign}</span>{/if}
        <span class="name">{tab.name}</span>
        {#if hints[i]}<span class="hint">{hints[i]}</span>{/if}
        <button class="close" class:dirty={tab.dirty} onpointerdown={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); close(tab.id); }} aria-label={t("common.close")}>
          <span class="x"><Glyph name="x" size={8} /></span><span class="d"></span>
        </button>
      </div>
    {/each}
    <button class="add" onclick={() => newFileInSession()} title={withShortcut(t("app.newFile"), "file.new")} aria-label={t("app.newFile")}><Glyph name="plus" size={11} /></button>
  </div>
  <!-- A narrow group (split, #219) keeps room for its tabs: first the language picker goes, then the run bar. -->
  {#if mode === "code"}
    {#if width >= 420}<LangPicker compact={width < 640} tab={activeHere} />{/if}
    {#if width >= 300}<RunBar {width} path={activeHere?.path ?? null} />{/if}
  {/if}
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
    min-width: min(150px, 45%);
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
    /* Tabs can be dragged into other groups (#219). */
    cursor: grab;
    user-select: none;
  }
  .tab .close { cursor: default; }
  .tab:hover { background: var(--fill-hover); color: var(--label); }
  .tab.dragging { background: var(--fill-2); }
  /* The mode this group shows its file in; only with several groups (#219). */
  .modechip {
    flex-shrink: 0;
    margin-left: 10px;
    height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--label-2);
    background: rgba(var(--fg-rgb), 0.07);
  }
  .modechip:hover { background: var(--fill-hover); color: var(--label); }
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
