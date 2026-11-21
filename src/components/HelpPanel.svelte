<script lang="ts">
  import { tick } from "svelte";
  import { app, activeTab } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import { allSheets, sheetIdFor, withKeys, type Sheet } from "../lib/help";
  import { COMMANDS, keysFor, keymapState, shortcutLabel } from "../lib/commands.svelte";
  import { formatKey } from "../lib/keys";
  import { t } from "../lib/i18n/index.svelte";

  /** Shortcuts are generated from the command registry, so custom bindings show up here. */
  function shortcutsSheet(): Sheet {
    void keymapState.overrides;
    const groups = new Map<string, [string, string][]>();
    for (const c of COMMANDS) {
      const keys = keysFor(c.id);
      if (!keys.length) continue;
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group)!.push([keys.map(formatKey).join("  ·  "), c.label + (c.modes ? ` (${c.modes.join(", ")})` : "")]);
    }
    const mouse: [string, string][] = [
      [t("help.altClick"), t("help.altClickDesc")],
      [t("help.altDrag"), t("help.altDragDesc")],
      [t("help.ctrlClick"), t("help.ctrlClickDesc")],
      [t("help.rightClickWord"), t("help.rightClickWordDesc")],
      [t("help.gutterClick"), t("help.gutterClickDesc")],
      [t("help.middleClickTab"), t("help.middleClickTabDesc")],
    ];
    return { title: t("help.shortcuts"), sections: [...[...groups].map(([title, rows]) => ({ title, rows })), { title: t("help.mouse"), rows: mouse }] };
  }
  import { effectiveLang } from "../lib/code/langOverride.svelte";
  import * as ed from "../lib/editor";

  /** Re-localized when the UI language changes (allSheets reads i18n.locale). */
  const sheets = $derived(allSheets());
  let selected = $state(sheetIdFor(app.mode, effectiveLang(activeTab()?.path ?? null)?.id ?? null));
  let filter = $state("");
  let input: HTMLInputElement | undefined = $state();
  const q = $derived(filter.trim().toLowerCase());
  const shortcuts = $derived(shortcutsSheet());
  const current = $derived(selected === "shortcuts" ? shortcuts : withKeys(sheets.find((s) => s.id === selected)?.sheet ?? shortcuts, shortcutLabel));
  /** Filtered once per keystroke; empty sections are dropped without re-creating the others. */
  const visibleSections = $derived(
    current.sections
      .map((sec) => ({ title: sec.title, rows: sec.rows.filter(([a, b]) => !q || a.toLowerCase().includes(q) || b.toLowerCase().includes(q)) }))
      .filter((sec) => sec.rows.length),
  );

  tick().then(() => input?.focus());

  function close() {
    ui.help = false;
    queueMicrotask(() => ed.focus());
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" role="dialog" aria-label={t("help.cheatSheet")}>
  <div class="sheet">
    <header>
      <div class="title">
        <h1>{current.title}</h1>
        <span class="sub">{t("help.cheatSheet")}</span>
      </div>
      <input bind:this={input} class="search" placeholder={t("help.search")} bind:value={filter} spellcheck="false" />
      <button class="close" onclick={close} aria-label={t("common.close")} title={t("help.closeEsc")}>
        <svg width="12" height="12" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </header>

    <nav class="chips">
      {#each sheets as s (s.id)}
        <button class="chip" class:on={s.id === selected} onclick={() => (selected = s.id)}>{s.label}</button>
      {/each}
    </nav>

    <div class="scroll">
      <div class="columns">
        {#each visibleSections as sec (selected + sec.title)}
          {@const rows = sec.rows}
          {#if rows.length}
            <section class="card">
              <h3>{sec.title}</h3>
              {#each rows as [code, desc], i (i)}
                <div class="row">
                  <code>{code}</code>
                  <span>{desc}</span>
                </div>
              {/each}
            </section>
          {/if}
        {/each}
      </div>
      {#if q && !current.sections.some((sec) => sec.rows.some(([a, b]) => a.toLowerCase().includes(q) || b.toLowerCase().includes(q)))}
        <p class="none">{t("help.noMatches", { q: filter })}</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    padding: 14px;
    background: var(--scrim);
    backdrop-filter: blur(18px) saturate(140%);
    user-select: text;
  }
  .sheet {
    height: 100%;
    display: flex;
    flex-direction: column;
    border-radius: 28px;
    background: var(--glass);
    box-shadow: var(--glass-highlight), 0 30px 90px rgba(0, 0, 0, 0.6);
    overflow: hidden;
    /* Appears instantly: fading the glass layer lets the editor flash through underneath. */
  }
  header { display: flex; align-items: center; gap: 18px; padding: 26px 26px 12px 34px; }
  .title { display: flex; align-items: baseline; gap: 12px; flex-shrink: 0; }
  h1 { margin: 0; font-size: 32px; font-weight: 750; letter-spacing: -0.025em; }
  .sub { color: var(--label-3); font-size: 14px; font-weight: 500; }
  .search { flex: 1; max-width: 420px; margin-left: auto; padding: 10px 18px; font-size: 14px; }
  .close {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--label);
    background: rgba(var(--fg-rgb), 0.08);
    box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.08);
    transition: background 0.2s;
  }
  .close:hover { background: rgba(var(--fg-rgb), 0.14); transform: rotate(90deg); }
  .close:active { transform: rotate(90deg) scale(0.9); }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 30px 16px; }
  .chip {
    height: 30px;
    padding: 0 14px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--label-2);
    background: rgba(var(--fg-rgb), 0.05);
    box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.05);
    transition: background 0.2s, color 0.2s;
  }
  .chip:hover { color: var(--label); background: rgba(var(--fg-rgb), 0.1); transform: translateY(-1px); }
  .chip:active { transform: scale(0.94); }
  .chip.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }

  .scroll { flex: 1; overflow: auto; padding: 4px 26px 30px; }
  .columns { columns: 360px; column-gap: 16px; }
  .card {
    break-inside: avoid;
    margin-bottom: 16px;
    padding: 14px 6px 6px;
    border-radius: 20px;
    background: rgba(var(--fg-rgb), 0.04);
    box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.05);
  }
  h3 { margin: 0 12px 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--label-2); }
  .row { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 14px; padding: 8px 12px; border-radius: 12px; font-size: 13px; align-items: baseline; }
  .row:hover { background: rgba(var(--fg-rgb), 0.05); }
  .row + .row { border-top: 1px solid rgba(var(--fg-rgb), 0.04); }
  code { font-family: var(--mono); font-size: 12.5px; color: var(--teal); white-space: pre-wrap; word-break: break-word; }
  .row span { color: var(--label-2); }
  .none { color: var(--label-3); padding: 20px 8px; }

  /* No open animation: any fade over the blurred backdrop flashes the editor in WebKitGTK. */

</style>
