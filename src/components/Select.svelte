<script lang="ts" generics="T extends string">
  /** Glass dropdown in the app's style (the native <select> popup is a plain GTK list). */
  import Glyph from "./Glyph.svelte";

  let { value, options, onchange, title = "", width = "auto" }: {
    value: T;
    options: { value: T; label: string }[];
    onchange: (v: T) => void;
    title?: string;
    width?: string;
  } = $props();

  let open = $state(false);
  let hover = $state(0);
  let trigger: HTMLButtonElement;
  let pos = $state({ x: 0, y: 0, w: 0, up: false });
  const current = $derived(options.find((o) => o.value === value));

  function show() {
    const r = trigger.getBoundingClientRect();
    const h = options.length * 32 + 12;
    const up = r.bottom + 6 + h > window.innerHeight && r.top - 6 - h > 0;
    pos = { x: r.left, y: up ? r.top - 6 - h : r.bottom + 6, w: r.width, up };
    hover = Math.max(0, options.findIndex((o) => o.value === value));
    open = true;
  }

  function pick(v: T) {
    open = false;
    trigger.focus();
    if (v !== value) onchange(v);
  }

  function onKey(e: KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") open = false;
    else if (e.key === "ArrowDown") hover = (hover + 1) % options.length;
    else if (e.key === "ArrowUp") hover = (hover - 1 + options.length) % options.length;
    else if (e.key === "Enter" || e.key === " ") pick(options[hover].value);
  }
</script>

<button bind:this={trigger} class="trigger" class:open style:width {title} onclick={() => (open ? (open = false) : show())} onkeydown={onKey} aria-haspopup="listbox" aria-expanded={open}>
  <span class="cur">{current?.label ?? ""}</span>
  <Glyph name="chevron-down" size={9} />
</button>

{#if open}
  <div class="catcher" role="presentation" onpointerdown={() => (open = false)}></div>
  <div class="menu" role="listbox" style="left: {pos.x}px; top: {pos.y}px; min-width: {pos.w}px">
    {#each options as o, i (o.value)}
      <button class="opt" class:hover={i === hover} role="option" aria-selected={o.value === value} onpointerenter={() => (hover = i)} onclick={() => pick(o.value)}>
        <span class="check">{#if o.value === value}<Glyph name="check" size={10} stroke={1.8} />{/if}</span>
        <span>{o.label}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: 32px;
    padding: 0 12px 0 14px;
    border-radius: 999px;
    background: rgba(var(--fg-rgb), 0.08);
    box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.07);
    color: var(--label);
    font-size: 12.5px;
    font-weight: 550;
    white-space: nowrap;
    transition: background 0.12s;
  }
  .trigger:hover, .trigger.open { background: rgba(var(--fg-rgb), 0.13); }
  .trigger :global(.glyph) { color: var(--label-2); }
  .trigger.open :global(.glyph) { transform: rotate(180deg); }
  .cur { overflow: hidden; text-overflow: ellipsis; }

  .catcher { position: fixed; inset: 0; z-index: 90; }
  .menu {
    position: fixed;
    z-index: 91;
    padding: 6px;
    border-radius: 16px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: var(--glass-highlight), 0 20px 50px rgba(0, 0, 0, 0.65);
    /* No open animation: fading/scaling an element with backdrop-filter makes WebKitGTK flash. */
  }
  .opt {
    width: 100%;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 14px 0 8px;
    border-radius: 10px;
    text-align: left;
    font-size: 13px;
    white-space: nowrap;
    color: var(--label);
  }
  .opt.hover { background: rgba(var(--fg-rgb), 0.12); }
  .check { width: 14px; display: grid; place-items: center; color: var(--accent); }
</style>
