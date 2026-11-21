<script lang="ts">
  import Glyph from "../Glyph.svelte";
  import { app } from "../../lib/state.svelte";
  import { terms, newTerminal, closeTerminal, focusTerm, listShells, shellPref, setDefaultShell, toggleSplit } from "../../lib/terminal.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { t } from "../../lib/i18n/index.svelte";
  import { guestGuard, localTerminalTitle } from "../../lib/collab/guard";

  // A guest's shells run on its own machine, never on the host.
  const isGuest = $derived(guestGuard.status() !== "none");

  let list: HTMLDivElement | undefined = $state();

  // The active tab (often the newest one, at the far right) is always scrolled into view.
  $effect(() => {
    void terms.tabs.length;
    const el = list?.querySelector<HTMLElement>(`[data-term="${CSS.escape(terms.active ?? "")}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
        ...shells.map((sh) => ({ label: `${sh.label}${sh.id === def ? " ✓" : ""}`, action: () => newTerminal(app.root, "shell", localTerminalTitle(), sh) })),
        { label: "", separator: true },
        ...shells
          .filter((sh) => sh.id !== def)
          .map((sh) => ({ label: t("code.term.makeDefault", { name: sh.label }), action: () => setDefaultShell(sh.id === shells[0]?.id ? "" : sh.id) })),
      ],
    };
  }
</script>

<div class="ttabs">
  <div class="list" bind:this={list}>
  {#each terms.tabs as tab (tab.id)}
    <div class="tab" data-term={tab.id} class:active={tab.id === terms.active} class:exited={tab.exited} role="tab" tabindex="0" aria-selected={tab.id === terms.active}
      onclick={() => { terms.active = tab.id; focusTerm(tab.id); }} onkeydown={(e) => e.key === "Enter" && (terms.active = tab.id)}>
      {#if tab.status && tab.status !== "running"}
        <span class="st {tab.status}" title={tab.status === "ok" ? t("code.term.stOk") : tab.status === "fail" ? t("code.term.stFail", { code: String(tab.code) }) : t("code.term.stStopped")}>{tab.status === "ok" ? "✓" : tab.status === "fail" ? "✗" : "■"}</span>
      {:else}
        <span class="dot" class:run={tab.kind === "run" || tab.kind === "build"} class:busy={tab.status === "running"} title={tab.status === "running" ? t("code.term.stRunning") : undefined}></span>
      {/if}
      <span class="label" title={tab.title}>{tab.title}</span>
      <button class="x" onclick={(e) => { e.stopPropagation(); closeTerminal(tab.id); }} aria-label={t("common.close")}><Glyph name="x" size={8} /></button>
    </div>
  {/each}
  </div>
  <button class="add" title={isGuest ? t("code.term.newLocal") : t("code.term.new")} aria-label={isGuest ? t("code.term.newLocal") : t("code.term.new")} onclick={() => newTerminal(app.root, "shell", localTerminalTitle())}><Glyph name="plus" size={10} /></button>
  <button class="add pick" title={t("code.term.chooseShell")} onclick={shellMenu}><Glyph name="chevron-down" size={10} /></button>
  {#if terms.tabs.length > 1 || terms.split}
    <button class="add split" class:on={terms.split} title={terms.split ? t("layout.termTabs") : t("layout.termSplit")} aria-label={t("layout.termSplit")} onclick={toggleSplit}>
      {#if terms.split}
        <svg width="14" height="14" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.5v11" stroke="currentColor" stroke-width="1.3"/></svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 5.5h13" stroke="currentColor" stroke-width="1.3"/></svg>
      {/if}
    </button>
  {/if}
</div>

<style>
  .ttabs { min-width: 0; flex: 0 1 auto; display: flex; align-items: center; gap: 4px; overflow: hidden; }
  .ttabs > * { flex-shrink: 0; }
  /* Tabs keep a readable minimum and scroll sideways; the buttons next to them stay put. */
  .list { flex: 0 1 auto; min-width: 0; display: flex; align-items: center; gap: 4px; overflow-x: auto; }
  .list::-webkit-scrollbar { height: 0; }
  /* Wide enough for "Terminal 3" or "cargo: Test", so tabs stay distinguishable. */
  .list > .tab { flex: 0 1 auto; min-width: 132px; max-width: 240px; }
  .tab { height: 28px; display: flex; align-items: center; gap: 7px; padding: 0 5px 0 12px; border-radius: 999px; color: var(--label-2); font-size: 12px; white-space: nowrap; cursor: default; }
  .tab > :not(.label) { flex-shrink: 0; }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .tab:hover { background: var(--fill-hover); color: var(--label); }
  .tab.active { background: rgba(var(--fg-rgb), 0.1); color: var(--label); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.08); }
  .tab.exited { opacity: 0.55; }
  .st { width: 9px; display: grid; place-items: center; font-size: 11px; font-weight: 700; line-height: 1; }
  .st.ok { color: var(--green); }
  .st.fail { color: var(--red); }
  .st.stopped { color: var(--label-3); font-size: 8px; }
  .dot.busy { animation: busy 1.1s ease-in-out infinite; }
  @keyframes busy { 50% { opacity: 0.3; transform: scale(0.75); } }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--label-3); }
  .dot.run { background: var(--green); }
  .x { width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; color: var(--label-2); }
  .x:hover { background: var(--fill-2); color: var(--label); }
  .add { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--label-2); }
  .add.pick { margin-left: -4px; }
  .add:hover { background: var(--fill-hover); color: var(--label); }
  .add.on { color: var(--label); background: rgba(var(--fg-rgb), 0.1); }
</style>
