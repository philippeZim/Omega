<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import Select from "./Select.svelte";
  import { COMMANDS, keysFor, setKeys, keymapState, conflicts, resetAllKeys, recording, applyKeymap, modeNames } from "../lib/commands.svelte";
  import { KEYMAPS, type KeymapId } from "../lib/keymaps";
  import { bindingFromEvent, formatKey, normalize } from "../lib/keys";
  import { ui } from "../lib/ui.svelte";
  import { t } from "../lib/i18n/index.svelte";

  let filter = $state("");
  let recordingId = $state<string | null>(null);
  const q = $derived(filter.trim().toLowerCase());

  const groups = $derived.by(() => {
    void keymapState.overrides;
    const map = new Map<string, typeof COMMANDS>();
    for (const c of COMMANDS) {
      const keys = keysFor(c.id).map(formatKey).join(" ").toLowerCase();
      if (q && !c.label.toLowerCase().includes(q) && !keys.includes(q) && !c.group.toLowerCase().includes(q)) continue;
      if (!map.has(c.group)) map.set(c.group, []);
      map.get(c.group)!.push(c);
    }
    return [...map];
  });

  function startRecording(id: string) {
    recordingId = id;
    recording.active = true;
  }

  function stopRecording() {
    recordingId = null;
    recording.active = false;
  }

  async function onKey(e: KeyboardEvent) {
    if (!recordingId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stopRecording();
    const b = bindingFromEvent(e);
    if (!b) return; // modifier only – keep waiting
    const id = recordingId;
    stopRecording();
    const key = normalize(b);
    if (keysFor(id).includes(key)) return;
    const clash = conflicts(id, key);
    if (clash.length) {
      const ok = await ui.confirm(
        t("commands.kb.inUse", { key: formatKey(key) }),
        t("commands.kb.usedBy", { cmds: clash.map((c) => c.label).join(", ") }),
        t("commands.kb.reassign"),
      );
      if (!ok) return;
      for (const c of clash) setKeys(c.id, keysFor(c.id).filter((k) => k !== key));
    }
    setKeys(id, [...keysFor(id), key]);
  }

  function removeKey(id: string, key: string) {
    setKeys(id, keysFor(id).filter((k) => k !== key));
  }

  /** "Omega" would read like Visual Studio, so the built-in keymap is shown as "Default". */
  const keymapName = (id: KeymapId) => (id === "omega" ? t("commands.kb.presetDefault") : KEYMAPS.find((k) => k.id === id)!.name);

  async function pickKeymap(id: KeymapId) {
    const name = keymapName(id);
    const custom = Object.keys(keymapState.overrides).length;
    let keep = false;
    if (custom) {
      const r = await ui.choose(t("commands.kb.presetTitle", { name }), t("commands.kb.presetCustom", { n: custom, name }), [
        { label: t("common.cancel"), value: "cancel" },
        { label: t("commands.kb.presetKeep"), value: "keep" },
        { label: t("commands.kb.presetReplace"), value: "replace", primary: true },
      ]);
      if (r !== "keep" && r !== "replace") return;
      keep = r === "keep";
    }
    applyKeymap(id, keep);
    ui.toast(t("commands.kb.presetApplied", { name }));
  }

  async function resetAll() {
    if (await ui.confirm(t("commands.kb.resetAllConfirm"), t("commands.kb.resetAllDetail"), t("commands.kb.reset"), true)) resetAllKeys();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="bar">
  <input placeholder={t("commands.kb.search")} bind:value={filter} spellcheck="false" />
  <div class="preset" title={t("commands.kb.presetHint")}>
    <span>{t("commands.kb.keymap")}</span>
    <Select value={keymapState.preset} options={KEYMAPS.map((k) => ({ value: k.id, label: keymapName(k.id) }))} onchange={pickKeymap} />
  </div>
  <button class="btn" onclick={resetAll}>{t("commands.kb.resetAll")}</button>
</div>

{#each groups as [group, cmds] (group)}
  <h3>{group}</h3>
  <div class="box">
    {#each cmds as c (c.id)}
      {@const keys = keysFor(c.id)}
      <div class="row" class:custom={c.id in keymapState.overrides}>
        <span class="label">{c.label}{#if c.modes}<span class="mode">{modeNames(c.modes)}</span>{/if}</span>
        <span class="keys">
          {#each keys as k (k)}
            <span class="chip">{formatKey(k)}<button class="x" onclick={() => removeKey(c.id, k)} aria-label={t("commands.kb.remove")}><Glyph name="x" size={7} /></button></span>
          {/each}
          {#if recordingId === c.id}
            <span class="chip rec">{t("commands.kb.pressKeys")} <small>{t("commands.kb.escCancels")}</small></span>
          {:else}
            <button class="add" title={t("commands.kb.add")} onclick={() => startRecording(c.id)}><Glyph name="plus" size={10} /></button>
          {/if}
          {#if c.id in keymapState.overrides}
            <button class="reset" title={t("commands.kb.restore")} onclick={() => setKeys(c.id, null)}>↺</button>
          {/if}
        </span>
      </div>
    {/each}
  </div>
{/each}

<style>
  .bar { display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 4px; }
  .bar input { flex: 1 1 200px; min-width: 0; }
  .preset { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--label-2); white-space: nowrap; }
  h3 { margin: 22px 2px 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--label-2); }
  .box { border-radius: 18px; background: rgba(var(--fg-rgb), 0.035); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.04); padding: 4px; }
  /* Label column up to 340px; the keys take the rest and drop below the label in very narrow windows. */
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 20px; min-height: 40px; padding: 4px 10px 4px 14px; border-radius: 12px; }
  .row:hover { background: rgba(var(--fg-rgb), 0.07); }
  .row + .row { border-top: 1px solid rgba(var(--fg-rgb), 0.035); }
  .label { font-size: 13px; flex: 0 1 340px; min-width: 0; }
  .keys { flex: 1 1 180px; min-width: 0; }
  .row.custom .label { color: var(--label); font-weight: 550; }
  .mode { margin-left: 8px; font-size: 10.5px; color: var(--label-3); }
  .keys { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-start; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding: 0 5px 0 10px;
    border-radius: 8px;
    font-family: var(--mono);
    font-size: 11.5px;
    background: var(--recess);
    box-shadow: var(--recess-shadow);
    color: var(--label);
  }
  .chip.rec { padding: 0 10px; color: var(--yellow); animation: pulse 1.2s ease-in-out infinite; font-family: var(--font); }
  .chip.rec small { color: var(--label-3); }
  .x { width: 16px; height: 16px; display: grid; place-items: center; border-radius: 50%; color: var(--label-3); opacity: 0; transition: opacity 0.15s; }
  .chip:hover .x { opacity: 1; }
  .x:hover { color: var(--label); background: var(--fill-2); }
  .add, .reset { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; color: var(--label-2); background: rgba(var(--fg-rgb), 0.05); transition: background 0.15s; }
  .add:hover, .reset:hover { background: rgba(var(--fg-rgb), 0.12); color: var(--label); }
  .add:active, .reset:active { transform: scale(0.9); }
  @keyframes pulse { 50% { color: var(--label-3); } }
</style>
