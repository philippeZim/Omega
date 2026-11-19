<script lang="ts">
  import { ui } from "../lib/ui.svelte";

  let el: HTMLDivElement | undefined = $state();
  let pos = $state({ x: 0, y: 0 });

  $effect(() => {
    const m = ui.menu;
    if (!m || !el) return;
    const r = el.getBoundingClientRect();
    pos = { x: Math.min(m.x, innerWidth - r.width - 6), y: Math.min(m.y, innerHeight - r.height - 6) };
  });

  const close = () => (ui.menu = null);
</script>

<svelte:window onblur={close} onkeydown={(e) => e.key === "Escape" && close()} />

{#if ui.menu}
  <div class="catcher" role="presentation" onpointerdown={close} oncontextmenu={(e) => { e.preventDefault(); close(); }}></div>
  <div class="menu" bind:this={el} style="left: {pos.x || ui.menu.x}px; top: {pos.y || ui.menu.y}px" role="menu">
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
    animation: pop 0.12s ease-out;
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
  @keyframes pop { from { opacity: 0; transform: scale(0.97); } }
</style>
