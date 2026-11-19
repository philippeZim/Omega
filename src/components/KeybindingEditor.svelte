<script lang="ts">
  import { COMMANDS, keysFor, setKeys, keymapState, conflicts, resetAllKeys, recording } from "../lib/commands.svelte";
  import { bindingFromEvent, formatKey, normalize } from "../lib/keys";
  import { ui } from "../lib/ui.svelte";

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
        `${formatKey(key)} ist schon belegt`,
        `Verwendet von: ${clash.map((c) => c.label).join(", ")}. Dort entfernen und hier zuweisen?`,
        "Umhängen",
      );
      if (!ok) return;
      for (const c of clash) setKeys(c.id, keysFor(c.id).filter((k) => k !== key));
    }
    setKeys(id, [...keysFor(id), key]);
  }

  function removeKey(id: string, key: string) {
    setKeys(id, keysFor(id).filter((k) => k !== key));
  }

  async function resetAll() {
    if (await ui.confirm("Alle Tastenkürzel zurücksetzen?", "Eigene Belegungen gehen verloren.", "Zurücksetzen", true)) resetAllKeys();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="bar">
  <input placeholder="Befehl oder Taste suchen…" bind:value={filter} spellcheck="false" />
  <button class="btn" onclick={resetAll}>Alle zurücksetzen</button>
</div>

{#each groups as [group, cmds] (group)}
  <h3>{group}</h3>
  <div class="box">
    {#each cmds as c (c.id)}
      {@const keys = keysFor(c.id)}
      <div class="row" class:custom={c.id in keymapState.overrides}>
        <span class="label">{c.label}{#if c.modes}<span class="mode">{c.modes.join(", ")}</span>{/if}</span>
        <span class="keys">
          {#each keys as k (k)}
            <span class="chip">{formatKey(k)}<button class="x" onclick={() => removeKey(c.id, k)} aria-label="Entfernen">×</button></span>
          {/each}
          {#if recordingId === c.id}
            <span class="chip rec">Tasten drücken… <small>Esc bricht ab</small></span>
          {:else}
            <button class="add" title="Tastenkürzel hinzufügen" onclick={() => startRecording(c.id)}>+</button>
          {/if}
          {#if c.id in keymapState.overrides}
            <button class="reset" title="Standard wiederherstellen" onclick={() => setKeys(c.id, null)}>↺</button>
          {/if}
        </span>
      </div>
    {/each}
  </div>
{/each}

<style>
  .bar { display: flex; gap: 10px; margin: 6px 0 4px; }
  .bar input { flex: 1; }
  h3 { margin: 22px 2px 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--label-2); }
  .box { border-radius: 18px; background: rgba(255, 255, 255, 0.035); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04); padding: 4px; }
  .row { display: grid; grid-template-columns: minmax(0, 340px) 1fr; align-items: center; gap: 20px; min-height: 40px; padding: 4px 10px 4px 14px; border-radius: 12px; }
  .row:hover { background: rgba(255, 255, 255, 0.07); }
  .row + .row { border-top: 1px solid rgba(255, 255, 255, 0.035); }
  .label { font-size: 13px; }
  .row.custom .label { color: #fff; font-weight: 550; }
  .mode { margin-left: 8px; font-size: 10.5px; color: var(--label-3); text-transform: capitalize; }
  .keys { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-start; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding: 0 6px 0 10px;
    border-radius: 8px;
    font-family: var(--mono);
    font-size: 11.5px;
    background: var(--recess);
    box-shadow: var(--recess-shadow);
    color: var(--label);
  }
  .chip.rec { padding: 0 10px; color: var(--yellow); animation: pulse 1.2s ease-in-out infinite; font-family: var(--font); }
  .chip.rec small { color: var(--label-3); }
  .x { width: 16px; height: 16px; border-radius: 50%; font-size: 12px; line-height: 1; color: var(--label-3); opacity: 0; transition: opacity 0.15s; }
  .chip:hover .x { opacity: 1; }
  .x:hover { color: var(--label); background: var(--fill-2); }
  .add, .reset { width: 26px; height: 26px; border-radius: 8px; color: var(--label-2); background: rgba(255, 255, 255, 0.05); transition: background 0.15s, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
  .add:hover, .reset:hover { background: rgba(255, 255, 255, 0.12); color: var(--label); }
  .add:active, .reset:active { transform: scale(0.9); }
  @keyframes pulse { 50% { opacity: 0.55; } }
</style>
