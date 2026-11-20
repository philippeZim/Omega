<script lang="ts">
  import { app, setMode } from "../lib/state.svelte";
  import { terms, newTerminal, closeTerminal, attach, fitTerm, focusTerm, setHeight, toggleTerminal, listShells, shellPref, setDefaultShell } from "../lib/terminal.svelte";
  import { ui } from "../lib/ui.svelte";
  import DebugConsole from "./DebugConsole.svelte";
  import SearchDock from "./SearchDock.svelte";
  import { find } from "../lib/search/search.svelte";
  import { t } from "../lib/i18n/index.svelte";

  // Docking search results shows the panel on their tab.
  $effect(() => {
    if (find.showDocked) {
      find.showDocked = false;
      if (app.mode !== "code") setMode("code");
      terms.visible = true;
      terms.active = "search";
    }
  });
  import { dbg } from "../lib/debug/store.svelte";

  const showConsole = $derived(dbg.status !== "idle" || dbg.console.length > 0);

  let body = $state<HTMLDivElement>();

  // Always have at least one shell when the panel is shown.
  $effect(() => {
    if (app.mode === "code" && terms.visible && terms.tabs.length === 0 && terms.active !== "search") newTerminal(app.root);
  });

  $effect(() => {
    const id = terms.active;
    void terms.height;
    if (!id || id === "console" || id === "search" || !body || !terms.visible || app.mode !== "code") return;
    const host = body;
    requestAnimationFrame(async () => {
      await attach(id, host, app.root);
      for (const el of host.querySelectorAll<HTMLElement>(".term-host")) el.style.display = el.dataset.tid === id ? "" : "none";
      fitTerm(id);
    });
  });

  function startResize(e: PointerEvent) {
    const startY = e.clientY, startH = terms.height;
    const move = (ev: PointerEvent) => setHeight(Math.min(innerHeight - 220, Math.max(120, startH - (ev.clientY - startY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  $effect(() => {
    const ro = new ResizeObserver(() => fitTerm(terms.active));
    if (body) ro.observe(body);
    return () => ro.disconnect();
  });

  /** Menu of available shells (WSL distributions, Git Bash, zsh/fish …) for a new terminal. */
  async function shellMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const shells = await listShells();
    const def = shellPref.id || shells[0]?.id;
    ui.menu = {
      x: r.left,
      y: r.bottom + 4,
      items: [
        ...shells.map((sh) => ({ label: `${sh.label}${sh.id === def ? " ✓" : ""}`, action: () => newTerminal(app.root, "shell", undefined, sh) })),
        { label: "", separator: true },
        ...shells
          .filter((sh) => sh.id !== def)
          .map((sh) => ({ label: t("code.term.makeDefault", { name: sh.label }), action: () => setDefaultShell(sh.id === shells[0]?.id ? "" : sh.id) })),
      ],
    };
  }
</script>

<section class="terminal glass" style="height: {terms.height}px" class:hidden={!terms.visible}>
  <div class="resizer" role="separator" onpointerdown={startResize}></div>
  <div class="head">
    {#each terms.tabs as tab (tab.id)}
      <div class="tab" class:active={tab.id === terms.active} class:exited={tab.exited} role="tab" tabindex="0" aria-selected={tab.id === terms.active}
        onclick={() => { terms.active = tab.id; focusTerm(tab.id); }} onkeydown={(e) => e.key === "Enter" && (terms.active = tab.id)}>
        <span class="dot" class:run={tab.kind === "run"}></span>
        <span>{tab.title}</span>
        <button class="x" onclick={(e) => { e.stopPropagation(); closeTerminal(tab.id); }} aria-label={t("common.close")}>×</button>
      </div>
    {/each}
    {#if showConsole}
      <div class="tab" class:active={terms.active === "console"} role="tab" tabindex="0" aria-selected={terms.active === "console"}
        onclick={() => (terms.active = "console")} onkeydown={(e) => e.key === "Enter" && (terms.active = "console")}>
        <span class="dot dbg"></span><span>{t("code.term.debugConsole")}</span>
      </div>
    {/if}
    {#if find.docked}
      <div class="tab" class:active={terms.active === "search"} role="tab" tabindex="0" aria-selected={terms.active === "search"}
        onclick={() => (terms.active = "search")} onkeydown={(e) => e.key === "Enter" && (terms.active = "search")}>
        <span class="dot srch"></span><span>{t("code.term.search", { query: find.docked.query })}</span>
        <button class="x" onclick={(e) => { e.stopPropagation(); find.docked = null; if (terms.active === "search") terms.active = terms.tabs[0]?.id ?? null; }} aria-label={t("common.close")}>×</button>
      </div>
    {/if}
    <button class="add" title={t("code.term.new")} onclick={() => newTerminal(app.root)}>+</button>
    <button class="add pick" title={t("code.term.chooseShell")} onclick={shellMenu}>▾</button>
    <span class="spacer"></span>
    <button class="add" title={t("code.term.hide")} onclick={toggleTerminal}>⌄</button>
  </div>
  <div class="body" class:console-on={terms.active === "console" || terms.active === "search"} bind:this={body} role="presentation" onclick={() => terms.active !== "console" && focusTerm()}></div>
  {#if terms.active === "console"}
    <div class="console-slot"><DebugConsole /></div>
  {:else if terms.active === "search"}
    <div class="console-slot"><SearchDock /></div>
  {/if}
</section>

<style>
  .terminal { position: relative; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden; }
  .terminal.hidden { display: none; }
  .resizer { position: absolute; top: -6px; left: 0; right: 0; height: 10px; cursor: row-resize; z-index: 5; }
  .head { height: 42px; flex-shrink: 0; display: flex; align-items: center; gap: 4px; padding: 0 10px; border-bottom: 1px solid rgba(var(--fg-rgb), 0.05); }
  .tab { height: 28px; display: flex; align-items: center; gap: 7px; padding: 0 6px 0 12px; border-radius: 999px; color: var(--label-2); font-size: 12px; }
  .tab:hover { background: var(--fill-hover); color: var(--label); }
  .tab.active { background: rgba(var(--fg-rgb), 0.1); color: var(--label); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.08); }
  .tab.exited { opacity: 0.55; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--label-3); }
  .dot.run { background: var(--green); }
  .dot.dbg { background: var(--orange); }
  .dot.srch { background: var(--yellow); }
  .body.console-on { display: none; }
  .console-slot { flex: 1; min-height: 0; position: relative; }
  .x { width: 18px; height: 18px; border-radius: 50%; font-size: 14px; line-height: 1; color: var(--label-2); }
  .x:hover { background: var(--fill-2); color: var(--label); }
  .add.pick { width: 18px; margin-left: -6px; font-size: 10px; }
  .add { width: 28px; height: 28px; border-radius: 50%; color: var(--label-2); font-size: 16px; }
  .add:hover { background: var(--fill-hover); color: var(--label); }
  .spacer { flex: 1; }
  .body { flex: 1; min-height: 0; position: relative; padding: 8px 4px 4px 14px; }
  .body :global(.term-host) { position: absolute; inset: 8px 6px 4px 14px; }
  .body :global(.xterm) { height: 100%; }
  .body :global(.xterm-viewport) { background: transparent !important; }
  .body :global(.xterm-viewport::-webkit-scrollbar-thumb) { background: rgba(var(--fg-rgb), 0.14); }
</style>
