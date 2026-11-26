<script lang="ts">
  import { IS_MAC } from "../lib/platform";
  import { onMount } from "svelte";
  import * as ed from "../lib/editor";
  import { app, newFileInSession, openFolder, paneReady } from "../lib/state.svelte";
  import { MODES } from "../lib/modes";

  import { ui, type MenuItem } from "../lib/ui.svelte";
  import { spellLangFor } from "../lib/state.svelte";
  import { activeTab } from "../lib/state.svelte";
  import { misspelledAt, suggest, addToDictionary, ignoreWord, refreshSpell } from "../lib/spell";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { selectAll } from "@codemirror/commands";
  import { openNewProject } from "../lib/code/runner.svelte";
  import { t, type Key } from "../lib/i18n/index.svelte";
  import { modeSwitchLabel, shortcutLabel } from "../lib/commands.svelte";
  import { runViewAction, viewActionState } from "../lib/editorActions";
  import { GOTO_IDS } from "../lib/code/lspGoto";
  import FileViewer from "./FileViewer.svelte";

  const NAV_COMMANDS = ["lsp.gotoDefinition", ...GOTO_IDS];

  /** The editor group this pane belongs to (#219). */
  let { gid }: { gid: string } = $props();

  let host: HTMLDivElement;
  onMount(() => {
    ed.mount(host, gid);
    paneReady(gid);
  });

  async function contextMenu(e: MouseEvent) {
    const view = ed.getView();
    if (!view || !app.activeId || app.groups.focused !== gid) return;
    e.preventDefault();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const sel = view.state.selection.main;
    // Right-click outside the selection moves the cursor there, like native editors.
    if (pos !== null && (pos < sel.from || pos > sel.to)) view.dispatch({ selection: { anchor: pos } });
    const items: MenuItem[] = [];
    const hit = pos !== null && app.spellEnabled ? misspelledAt(view, pos) : null;
    if (hit) {
      const lang = spellLangFor(activeTab()?.path ?? null);
      const sugg = await suggest(lang, hit.word);
      if (sugg.length)
        for (const s of sugg)
          items.push({ label: s, action: () => view.dispatch({ changes: { from: hit.from, to: hit.to, insert: s }, selection: { anchor: hit.from + s.length } }) });
      else items.push({ label: t("code.ed.noSuggestions"), action: () => {} });
      items.push(
        { separator: true, label: "" },
        { label: t("code.ed.addToDict", { word: hit.word }), action: () => { addToDictionary(lang, hit.word); refreshSpell(view); } },
        { label: t("code.ed.ignore"), action: () => { ignoreWord(hit.word); refreshSpell(view); } },
        { separator: true, label: "" },
      );
    }
    // Language server navigation, where this editor has it.
    const nav = NAV_COMMANDS.flatMap((id) => {
      const state = viewActionState(view, id);
      if (!state) return [];
      const run = () => {
        if (pos !== null) view.dispatch({ selection: { anchor: pos } });
        runViewAction(view, id);
      };
      return [{ label: t(`commands.cmd.${id}` as Key), shortcut: shortcutLabel(id) || undefined, disabled: state === "disabled", action: run }];
    });
    if (nav.length) items.push(...nav, { separator: true, label: "" });
    const s = view.state.selection.main;
    const hasSel = !s.empty;
    const ctrl = IS_MAC ? "⌘" : t("code.key.ctrl");
    items.push(
      ...(hasSel
        ? [
            { label: t("code.ed.cut"), shortcut: `${ctrl} X`, action: async () => { await writeText(view.state.sliceDoc(s.from, s.to)); view.dispatch(view.state.replaceSelection("")); } },
            { label: t("code.ed.copy"), shortcut: `${ctrl} C`, action: () => writeText(view.state.sliceDoc(s.from, s.to)) },
          ]
        : []),
      { label: t("code.ed.paste"), shortcut: `${ctrl} V`, action: async () => { const text = await readText(); if (text) view.dispatch(view.state.replaceSelection(text)); view.focus(); } },
      { separator: true, label: "" },
      { label: t("code.ed.selectAll"), shortcut: `${ctrl} A`, action: () => { selectAll(view); view.focus(); } },
    );
    ui.menu = { x: e.clientX, y: e.clientY, items };
  }

  const active = $derived(app.groups.groups[gid]?.active ?? null);
  const shownTab = $derived(active ? (app.tabs.find((x) => x.id === active) ?? null) : null);
  const viewerTab = $derived(shownTab?.viewOf ? shownTab : null);
  const modeLabel = $derived(MODES.find((m) => m.id === app.mode)?.label);
  /** Hints follow the configured keymap; unbound commands are left out. */
  const newKey = $derived(shortcutLabel("file.new"));
  const openKey = $derived(shortcutLabel("file.openFolder"));
  const hint = $derived.by(() => {
    const modes = modeSwitchLabel(), help = shortcutLabel("app.help");
    return [modes && t("code.ed.hintModes", { keys: modes }), help && t("code.ed.hintHelp", { key: help })].filter(Boolean).join(" · ");
  });
</script>

<div class="pane">
  <div class="host" class:hidden={!active || !!viewerTab} bind:this={host} oncontextmenu={contextMenu} role="presentation"></div>
  {#if viewerTab}
    {#key viewerTab.id}<FileViewer tab={viewerTab} />{/key}
  {/if}
  {#if !active}
    <div class="welcome">
      <div class="inner">
      <h1>{modeLabel}</h1>
      <div class="actions">
        <button class="btn" onclick={() => newFileInSession()}>{t("code.ed.newFile")}{#if newKey} <kbd>{newKey}</kbd>{/if}</button>
        <button class="btn" onclick={openFolder}>{t("code.ed.openFolder")}{#if openKey} <kbd>{openKey}</kbd>{/if}</button>
        {#if app.mode === "code"}<button class="btn primary" onclick={openNewProject}>{t("code.np.newProject")}</button>{/if}
      </div>
      {#if hint}<p class="hint">{hint}</p>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .pane { position: relative; flex: 1; min-height: 0; }
  .host { position: absolute; inset: 0; user-select: text; }
  .host.hidden { display: none; }
  .welcome {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    padding: 16px;
    text-align: center;
    color: var(--label-2);
    overflow: auto;
  }
  /* margin: auto centres while there is room and never pushes content above the top edge. */
  .inner { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 18px; }
  h1 { margin: 0; font-size: 34px; font-weight: 700; letter-spacing: -0.02em; color: var(--label); }
  .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
  .actions .btn { white-space: nowrap; }
  kbd { font-family: var(--font); font-size: 11px; color: var(--label-3); margin-left: 8px; }
  .hint { margin: 0; font-size: 12px; color: var(--label-3); }
</style>
