<script lang="ts">
  import { IS_MAC } from "../lib/platform";
  import { onMount } from "svelte";
  import * as ed from "../lib/editor";
  import { app, newFile, openFolder } from "../lib/state.svelte";
  import { MODES } from "../lib/modes";

  import { ui, type MenuItem } from "../lib/ui.svelte";
  import { spellLangFor } from "../lib/state.svelte";
  import { activeTab } from "../lib/state.svelte";
  import { misspelledAt, suggest, addToDictionary, ignoreWord, refreshSpell } from "../lib/spell";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { selectAll } from "@codemirror/commands";
  import { runner } from "../lib/code/runner.svelte";
  import { t } from "../lib/i18n/index.svelte";

  let host: HTMLDivElement;
  onMount(() => ed.mount(host));

  async function contextMenu(e: MouseEvent) {
    const view = ed.getView();
    if (!view || !app.activeId) return;
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

  const modeLabel = $derived(MODES.find((m) => m.id === app.mode)?.label);
</script>

<div class="pane">
  <div class="host" class:hidden={!app.activeId} bind:this={host} oncontextmenu={contextMenu} role="presentation"></div>
  {#if !app.activeId}
    <div class="welcome">
      <h1>{modeLabel}</h1>
      <div class="actions">
        <button class="btn" onclick={newFile}>{t("code.ed.newFile")} <kbd>{IS_MAC ? "⌘" : t("code.key.ctrl")} N</kbd></button>
        <button class="btn" onclick={openFolder}>{t("code.ed.openFolder")} <kbd>{IS_MAC ? "⌘" : t("code.key.ctrl")} O</kbd></button>
        {#if app.mode === "code"}<button class="btn primary" onclick={() => (runner.newProject = true)}>{t("code.np.newProject")}</button>{/if}
      </div>
      <p class="hint">{t("code.ed.hint")}</p>
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
    align-items: center;
    justify-content: center;
    gap: 18px;
    color: var(--label-2);
  }
  h1 { margin: 0; font-size: 34px; font-weight: 700; letter-spacing: -0.02em; color: var(--label); }
  .actions { display: flex; gap: 10px; }
  kbd { font-family: var(--font); font-size: 11px; color: var(--label-3); margin-left: 8px; }
  .hint { margin: 0; font-size: 12px; color: var(--label-3); }
</style>
