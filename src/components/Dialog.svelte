<script lang="ts">
  import { ui } from "../lib/ui.svelte";
  import { tick } from "svelte";
  import * as ed from "../lib/editor";

  let value = $state("");
  let input: HTMLInputElement | undefined = $state();
  let alertEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    const d = ui.dialog;
    if (d?.input) {
      value = d.input.value;
      tick().then(() => {
        input?.focus();
        input?.setSelectionRange(0, d.input?.selectUntil ?? value.length);
      });
    } else if (d) {
      // Keep Enter/Escape away from the editor while an alert is open.
      tick().then(() => alertEl?.focus());
    }
  });

  function close(v: string | null) {
    const d = ui.dialog;
    ui.dialog = null;
    d?.resolve(v, value);
    queueMicrotask(() => { if (!ui.dialog) ed.focus(); });
  }

  function onKey(e: KeyboardEvent) {
    if (!ui.dialog) return;
    if (e.key === "Escape") { e.preventDefault(); close(null); }
    if (e.key === "Enter") {
      e.preventDefault();
      close(ui.dialog.options.find((o) => o.primary)?.value ?? null);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.dialog}
  <div class="backdrop" role="presentation" onclick={() => close(null)}>
    <div class="alert" bind:this={alertEl} role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
      <div class="body">
        <h2>{ui.dialog.title}</h2>
        {#if ui.dialog.message}<p>{ui.dialog.message}</p>{/if}
        {#if ui.dialog.input}
          <input bind:this={input} bind:value placeholder={ui.dialog.input.placeholder} spellcheck="false" />
        {/if}
      </div>
      <div class="buttons" style="--n: {ui.dialog.options.length}">
        {#each ui.dialog.options as o (o.value)}
          <button class:primary={o.primary} class:danger={o.danger} onclick={() => close(o.value)}>{o.label}</button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.55);
    animation: fade 0.15s ease-out;
  }
  .alert {
    width: 320px;
    border-radius: 26px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: var(--glass-highlight), 0 30px 80px rgba(0, 0, 0, 0.7);
    overflow: hidden;
    outline: none;
    animation: pop 0.2s cubic-bezier(0.3, 1.3, 0.5, 1);
  }
  .body { padding: 20px 18px 16px; text-align: center; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  p { margin: 6px 0 0; font-size: 12.5px; color: var(--label-2); line-height: 1.4; }
  input { width: 100%; margin-top: 14px; }
  .buttons { display: grid; grid-template-columns: repeat(var(--n), 1fr); gap: 8px; padding: 0 14px 14px; }
  .buttons button { height: 38px; border-radius: 999px; font-size: 13.5px; font-weight: 500; background: rgba(255, 255, 255, 0.08); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06); }
  .buttons button:hover { background: rgba(255, 255, 255, 0.14); }
  .buttons button.primary { font-weight: 600; background: var(--accent); color: white; }
  .buttons button.danger { color: var(--red); }
  @keyframes fade { from { opacity: 0; } }
  @keyframes pop { from { transform: scale(1.12); opacity: 0; } }
</style>
