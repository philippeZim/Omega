<script lang="ts">
  import { ui } from "../lib/ui.svelte";
  import { tick } from "svelte";
  import * as ed from "../lib/editor";
  import { t } from "../lib/i18n/index.svelte";
  import type { Suggestion } from "../lib/code/packages";

  let value = $state("");
  let items = $state<Suggestion[]>([]);
  let hl = $state(-1);
  let loaded = $state(false);
  let listEl: HTMLDivElement | undefined = $state();
  let seq = 0;
  let timer: number | undefined;
  const suggest = $derived(ui.dialog?.input?.suggest);

  // Refresh suggestions as the user types (debounced; stale answers are dropped).
  $effect(() => {
    const fn = suggest;
    const q = value;
    if (!fn) return;
    clearTimeout(timer);
    const my = ++seq;
    timer = window.setTimeout(async () => {
      const r = await fn(q).catch(() => []);
      if (my !== seq) return;
      items = r;
      hl = -1;
      loaded = true;
    }, q ? 120 : 0);
  });

  function pick(s: Suggestion) {
    value = s.value;
    input?.focus();
  }

  /** Double-click on a suggestion = take it and confirm (like pressing OK). */
  function confirmPick(s: Suggestion) {
    value = s.value;
    close(ui.dialog?.options.find((o) => o.primary)?.value ?? null);
  }

  function move(d: number) {
    if (!items.length) return;
    hl = (hl + d + items.length) % items.length;
    tick().then(() => listEl?.children[hl]?.scrollIntoView({ block: "nearest" }));
  }
  let input: HTMLInputElement | HTMLTextAreaElement | undefined = $state();
  let alertEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    const d = ui.dialog;
    if (d?.input) {
      value = d.input.value;
      items = [];
      hl = -1;
      loaded = false;
      tick().then(() => {
        input?.focus();
        if (d.input?.multiline) input?.setSelectionRange(value.length, value.length);
        else input?.setSelectionRange(0, d.input?.selectUntil ?? value.length);
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
    if (suggest && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); move(e.key === "ArrowDown" ? 1 : -1); }
    if (suggest && e.key === "Tab" && items.length) { e.preventDefault(); pick(items[Math.max(hl, 0)]); }
    if (e.key === "Enter") {
      e.preventDefault();
      if (hl >= 0 && items[hl]) value = items[hl].value;
      close(ui.dialog.options.find((o) => o.primary)?.value ?? null);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.dialog}
  <div class="backdrop" role="presentation" onclick={() => close(null)}>
    <div class="alert" class:wide={!!suggest} class:xwide={ui.dialog.input?.multiline} bind:this={alertEl} role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
      <div class="body">
        <h2>{ui.dialog.title}</h2>
        {#if ui.dialog.message}<p>{ui.dialog.message}</p>{/if}
        {#if ui.dialog.input}
          {#if ui.dialog.input.multiline}
            <textarea class="long" bind:this={input} bind:value placeholder={ui.dialog.input.placeholder} spellcheck="false" rows="4"></textarea>
          {:else}
            <input bind:this={input} bind:value placeholder={ui.dialog.input.placeholder} spellcheck="false" autocomplete="off" />
          {/if}
          {#if suggest}
            <div class="sugg" bind:this={listEl} role="listbox">
              {#each items as s, i (s.value)}
                <button class="opt" class:on={i === hl} role="option" aria-selected={i === hl} onmouseenter={() => (hl = i)} onclick={() => pick(s)} ondblclick={() => confirmPick(s)}>
                  <span class="name">{s.value}</span>
                  {#if s.detail}<span class="detail">{s.detail}</span>{/if}
                  {#if s.tag}<span class="tag" class:inst={s.tag === "installed"}>{s.tag === "installed" ? t("code.pkg.installed") : s.tag}</span>{/if}
                </button>
              {:else}
                {#if loaded}<p class="none">{value.trim() ? t("code.pkg.noMatch") : t("code.pkg.none")}</p>{/if}
              {/each}
            </div>
          {/if}
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
    background: var(--scrim);
  }
  .alert {
    width: 320px;
    border-radius: 26px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: var(--glass-highlight), 0 30px 80px rgba(0, 0, 0, 0.7);
    overflow: hidden;
    outline: none;
    /* No open animation: fading/scaling over the blurred backdrop makes WebKitGTK flash. */
  }
  .alert.wide { width: 440px; }
  .alert.xwide { width: min(640px, 92vw); }
  /* Long values (shell commands): wraps, monospace, resizable vertically. */
  .long { display: block; width: 100%; margin-top: 14px; min-height: 92px; max-height: 50vh; resize: vertical; padding: 10px 14px; border: none; border-radius: 16px; font: 12.5px/1.55 var(--mono); color: var(--label); background: var(--recess); box-shadow: var(--recess-shadow); text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; outline: none; }
  .long:focus { box-shadow: var(--recess-shadow), 0 0 0 1px rgba(var(--fg-rgb), 0.14); }
  .body { padding: 20px 18px 16px; text-align: center; }
  .sugg { margin-top: 10px; height: 232px; overflow-y: auto; text-align: left; border-radius: 16px; padding: 4px; background: var(--recess); box-shadow: var(--recess-shadow); }
  .opt { width: 100%; display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 4px 10px; border-radius: 999px; text-align: left; color: var(--label-2); transition: background 0.15s, color 0.15s; }
  /* Highlight = the raised glass pill used by the segmented controls (no accent colour). */
  .opt.on { background: var(--raised-bg); box-shadow: var(--raised-shadow); color: var(--label); }
  .opt .name { color: var(--label); }
  .opt .name { font-family: var(--mono); font-size: 12.5px; flex-shrink: 0; }
  .opt .detail { flex: 1; min-width: 0; font-size: 12px; color: var(--label-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .opt .tag { margin-left: auto; flex-shrink: 0; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; color: var(--label-2); background: rgba(var(--fg-rgb), 0.08); }
  .opt .tag.inst { color: var(--label-2); }
  .none { margin: 0; padding: 18px 10px; text-align: center; font-size: 12.5px; color: var(--label-3); }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  p { margin: 6px 0 0; font-size: 12.5px; color: var(--label-2); line-height: 1.4; }
  input { width: 100%; margin-top: 14px; }
  .buttons { display: grid; grid-template-columns: repeat(var(--n), 1fr); gap: 8px; padding: 0 14px 14px; }
  .buttons button { height: 38px; border-radius: 999px; font-size: 13.5px; font-weight: 500; background: rgba(var(--fg-rgb), 0.08); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.06); }
  .buttons button:hover { background: rgba(var(--fg-rgb), 0.14); }
  .buttons button.primary { font-weight: 600; background: var(--accent); color: white; }
  .buttons button.danger { color: var(--red); }
</style>
