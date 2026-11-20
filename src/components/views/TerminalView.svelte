<script lang="ts">
  import { app } from "../../lib/state.svelte";
  import { terms, newTerminal, attach, fitTerm, focusTerm } from "../../lib/terminal.svelte";
  import { isShown, registerFocus } from "../../lib/layout.svelte";

  let body = $state<HTMLDivElement>();
  /** Split mode: side by side in wide zones, stacked in tall ones. */
  let wide = $state(true);
  const shown = $derived(isShown("terminal"));

  registerFocus("terminal", () => focusTerm());

  // Always have at least one shell when the view is shown.
  $effect(() => {
    if (shown && terms.tabs.length === 0) newTerminal(app.root);
  });

  $effect(() => {
    const ids = terms.split ? terms.tabs.map((t) => t.id) : terms.active ? [terms.active] : [];
    const split = terms.split;
    void wide;
    if (!ids.length || !body || !shown) return;
    const host = body;
    requestAnimationFrame(async () => {
      for (const id of ids) await attach(id, host, app.root);
      // Keep the hosts in tab order (attach appends newly attached ones at the end).
      const els = ids.map((id) => host.querySelector<HTMLElement>(`:scope > .term-host[data-tid="${id}"]`)).filter((e): e is HTMLElement => !!e);
      const current = [...host.querySelectorAll<HTMLElement>(":scope > .term-host")].filter((e) => els.includes(e));
      if (current.some((e, i) => e !== els[i])) for (const e of els) host.appendChild(e);
      for (const el of host.querySelectorAll<HTMLElement>(":scope > .term-host")) el.style.display = ids.includes(el.dataset.tid!) ? "" : "none";
      for (const el of host.querySelectorAll<HTMLElement>(":scope > .term-host")) el.classList.toggle("active", el.dataset.tid === terms.active);
      for (const id of ids) fitTerm(id);
      void split;
    });
  });

  $effect(() => {
    if (!body) return;
    const el = body;
    const ro = new ResizeObserver(() => {
      wide = el.clientWidth >= el.clientHeight * 1.3;
      for (const t of terms.split ? terms.tabs : []) fitTerm(t.id);
      if (!terms.split) fitTerm(terms.active);
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Split mode: highlight the active terminal.
  $effect(() => {
    const a = terms.active;
    void terms.tabs.length;
    if (!body) return;
    for (const el of body.querySelectorAll<HTMLElement>(":scope > .term-host")) el.classList.toggle("active", el.dataset.tid === a);
  });

  /** Split mode: clicking a terminal makes it the active one. */
  function pick(e: MouseEvent) {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".term-host")?.dataset.tid;
    if (id) terms.active = id;
    focusTerm();
  }
</script>

<div class="body" class:split={terms.split} class:wide bind:this={body} role="presentation" onclick={pick}></div>

<style>
  .body { flex: 1; min-height: 0; position: relative; padding: 8px 4px 4px 14px; }
  .body :global(.term-host) { position: absolute; inset: 8px 6px 4px 14px; }
  .body :global(.xterm) { height: 100%; }
  .body :global(.xterm-viewport) { background: transparent !important; }
  .body :global(.xterm-viewport::-webkit-scrollbar-thumb) { background: rgba(var(--fg-rgb), 0.14); }

  .body.split { display: flex; flex-direction: column; gap: 6px; padding: 6px; }
  .body.split.wide { flex-direction: row; }
  .body.split :global(.term-host) { position: relative; inset: auto; flex: 1 1 0; min-width: 0; min-height: 0; padding: 6px 4px 4px 10px; border-radius: 12px; background: rgba(var(--fg-rgb), 0.025); box-shadow: inset 0 0 0 1px rgba(var(--fg-rgb), 0.06); }
  .body.split :global(.term-host.active) { box-shadow: inset 0 0 0 1px rgba(var(--fg-rgb), 0.28); }
</style>
