<script lang="ts">
  import { app, activeTab } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import { runner, refreshProject, runAction } from "../lib/code/runner.svelte";
  import { startDebugging, stopDebugging } from "../lib/debug/debugger.svelte";
  import { dbg } from "../lib/debug/store.svelte";
  import { langFor } from "../lib/code/languages";
  import { terms, toggleTerminal, focusTerm } from "../lib/terminal.svelte";
  import { t } from "../lib/i18n/index.svelte";

  function terminal() {
    toggleTerminal();
    if (terms.visible) requestAnimationFrame(() => focusTerm());
  }

  const lang = $derived(langFor(activeTab()?.path ?? null));
  const canDebug = $derived(!!lang?.server);
  const debugging = $derived(dbg.status === "running" || dbg.status === "stopped" || dbg.status === "starting");

  $effect(() => {
    void activeTab()?.path;
    void app.root;
    void app.treeVersion;
    refreshProject();
  });

  const p = $derived(runner.project);

  function moreMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ui.openMenu(new MouseEvent("contextmenu", { clientX: r.right - 240, clientY: r.bottom + 8 }), [
      ...(p?.more ?? []).map((a) => ({ label: a.label, action: () => runAction(a) })),
    ]);
  }

</script>

<div class="runbar">
  {#if p}
    <div class="gcap">
      {#if p.run}
        <button class="gbtn icon run" title="{p.run.label} (⇧F10)" onclick={() => runAction(p.run)} aria-label={p.run.label}>
          <svg class="ico" width="11" height="12" viewBox="0 0 11 12"><path d="M1.5 1.2v9.6a.6.6 0 0 0 .9.5l7.8-4.8a.6.6 0 0 0 0-1L2.4.7a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>
        </button>
      {/if}
      {#if canDebug}
        <button class="gbtn icon debug" class:live={debugging} title={debugging ? t("code.rb.debugging") : `${t("code.debug")} (⇧F9)`} onclick={startDebugging} aria-label={t("code.debug")}>
          <svg class="ico" width="14" height="14" viewBox="0 0 16 16"><path d="M8 3.2c-1.6 0-2.8 1.3-2.8 2.9v.4h5.6v-.4C10.8 4.5 9.6 3.2 8 3.2zM4.6 7.5v2.8a3.4 3.4 0 0 0 6.8 0V7.5z" fill="currentColor"/><path d="M2.5 8.5h2M11.5 8.5h2M3 5l1.8 1.3M13 5l-1.8 1.3M3 12.5l1.8-1M13 12.5l-1.8-1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
      {/if}
      {#if debugging}
        <button class="gbtn icon stop appear" title={t("code.rb.stopDebuggingTitle")} onclick={stopDebugging} aria-label={t("code.rb.stopDebugging")}>
          <svg class="ico" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2.4" fill="currentColor"/></svg>
        </button>
      {/if}
    </div>

    {#if p.build || p.test}
      <div class="gcap">
        {#if p.build}
          <button class="gbtn neutral" title={t("code.rb.buildTitle", { label: p.build.label })} onclick={() => runAction(p.build)}>
            <svg class="ico" width="13" height="13" viewBox="0 0 14 14"><path d="M8.6 1.6a3.4 3.4 0 0 0-3.9 4.6L1.4 9.5a1.4 1.4 0 0 0 2 2l3.3-3.3a3.4 3.4 0 0 0 4.6-3.9L9.4 6.2 7.8 6.1 7.7 4.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
            {p.build.label}
          </button>
        {/if}
        {#if p.test}
          <button class="gbtn neutral" title={p.test.label} onclick={() => runAction(p.test)}>
            <svg class="ico" width="13" height="13" viewBox="0 0 14 14"><path d="M5 1.5h4M6 1.5v4L2.3 11a1 1 0 0 0 .8 1.5h7.8a1 1 0 0 0 .8-1.5L8 5.5v-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            {p.test.label}
          </button>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="gcap">
    <button class="gbtn icon" class:on={terms.visible} title={t("code.rb.toggleTerminal")} onclick={terminal} aria-label="Terminal">
      <svg width="15" height="15" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 6.2l2 1.8-2 1.8M8 10h3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    {#if debugging}
      <button class="gbtn icon appear" class:on={dbg.panel} title={t("code.rb.toggleDebugPanel")} onclick={() => (dbg.panel = !dbg.panel)} aria-label={t("code.rb.debugPanel")}>
        <svg width="15" height="15" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" stroke-width="1.3"/></svg>
      </button>
    {/if}
    {#if p?.more.length}
      <button class="gbtn icon" title={t("code.rb.moreActions")} onclick={moreMenu} aria-label={t("code.rb.more")}>
        <svg width="14" height="4" viewBox="0 0 14 4"><circle cx="2" cy="2" r="1.5" fill="currentColor"/><circle cx="7" cy="2" r="1.5" fill="currentColor"/><circle cx="12" cy="2" r="1.5" fill="currentColor"/></svg>
      </button>
    {/if}
  </div>
</div>

<style>
  .runbar { display: flex; align-items: center; gap: 8px; margin-left: auto; padding-left: 12px; flex-shrink: 0; }
</style>
