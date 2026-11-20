<script lang="ts">
  import { ui } from "../lib/ui.svelte";

  let el: HTMLDivElement | undefined = $state();
  // Position for the menu it was measured for; until then the menu stays invisible, so it never
  // shows for a frame at a stale/unclamped spot and then jumps.
  let pos = $state.raw<{ x: number; y: number; menu: typeof ui.menu }>({ x: 0, y: 0, menu: null });

  $effect(() => {
    const m = ui.menu;
    if (!m || !el) return;
    const r = el.getBoundingClientRect();
    pos = { x: Math.max(6, Math.min(m.x, innerWidth - r.width - 6)), y: Math.max(6, Math.min(m.y, innerHeight - r.height - 6)), menu: m };
  });

  const close = () => (ui.menu = null);
</script>

<svelte:window onblur={close} onkeydown={(e) => e.key === "Escape" && close()} />

{#if ui.menu}
  <div class="catcher" role="presentation" onpointerdown={close} oncontextmenu={(e) => { e.preventDefault(); close(); }}></div>
  <div class="menu" bind:this={el} style="left: {pos.menu === ui.menu ? pos.x : ui.menu.x}px; top: {pos.menu === ui.menu ? pos.y : ui.menu.y}px; visibility: {pos.menu === ui.menu ? 'visible' : 'hidden'}" role="menu">
    {#each ui.menu.items as item, i (i)}
      {#if item.separator}
        <div class="sep"></div>
      {:else}
        <button role="menuitem" class:danger={item.danger} onclick={() => { close(); item.action?.(); }}>
          <span>{item.label}</span>
          {#if item.shortcut}<span class="sc">{item.shortcut}</span>{/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .catcher { position: fixed; inset: 0; z-index: 90; }
  .menu {
    position: fixed;
    z-index: 91;
    min-width: 210px;
    padding: 6px;
    border-radius: 18px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: var(--glass-highlight), 0 20px 50px rgba(0, 0, 0, 0.65);
    /* No open animation: fading/scaling an element with backdrop-filter makes WebKitGTK flash. */
  }
  button {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 20px;
    padding: 7px 12px;
    border-radius: 11px;
    text-align: left;
    font-size: 13px;
  }
  button:hover { background: rgba(var(--fg-rgb), 0.12); }
  button.danger { color: var(--red); }
  button.danger:hover { background: var(--red); color: white; }
  .sc { color: var(--label-3); }

  .sep { height: 1px; margin: 5px 10px; background: rgba(var(--fg-rgb), 0.07); }
</style>
