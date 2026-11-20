<script lang="ts">
  import Glyph from "../Glyph.svelte";
  import { app } from "../../lib/state.svelte";
  import { terms, newTerminal, closeTerminal, focusTerm, listShells, shellPref, setDefaultShell, toggleSplit } from "../../lib/terminal.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { t } from "../../lib/i18n/index.svelte";

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

<div class="ttabs">
  {#each terms.tabs as tab (tab.id)}
    <div class="tab" class:active={tab.id === terms.active} class:exited={tab.exited} role="tab" tabindex="0" aria-selected={tab.id === terms.active}
      onclick={() => { terms.active = tab.id; focusTerm(tab.id); }} onkeydown={(e) => e.key === "Enter" && (terms.active = tab.id)}>
      <span class="dot" class:run={tab.kind === "run"}></span>
      <span class="label" title={tab.title}>{tab.title}</span>
      <button class="x" onclick={(e) => { e.stopPropagation(); closeTerminal(tab.id); }} aria-label={t("common.close")}><Glyph name="x" size={8} /></button>
    </div>
  {/each}
  <button class="add" title={t("code.term.new")} onclick={() => newTerminal(app.root)}><Glyph name="plus" size={10} /></button>
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
  .ttabs > .tab { flex-shrink: 1; min-width: 0; max-width: 240px; }
  .tab { height: 28px; display: flex; align-items: center; gap: 7px; padding: 0 5px 0 12px; border-radius: 999px; color: var(--label-2); font-size: 12px; white-space: nowrap; cursor: default; }
  .tab > :not(.label) { flex-shrink: 0; }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .tab:hover { background: var(--fill-hover); color: var(--label); }
  .tab.active { background: rgba(var(--fg-rgb), 0.1); color: var(--label); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.08); }
  .tab.exited { opacity: 0.55; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--label-3); }
  .dot.run { background: var(--green); }
  .x { width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; color: var(--label-2); }
  .x:hover { background: var(--fill-2); color: var(--label); }
  .add { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--label-2); }
  .add.pick { margin-left: -4px; }
  .add:hover { background: var(--fill-hover); color: var(--label); }
  .add.on { color: var(--label); background: rgba(var(--fg-rgb), 0.1); }
</style>
