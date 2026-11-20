<script lang="ts">
  /**
   * App-wide tooltips. Native `title` tooltips are drawn by GTK and can't be styled, so any element
   * with a `title` gets it moved to `data-tip` on hover and shown here as a glass pill instead.
   */
  import { onMount } from "svelte";

  let text = $state("");
  let visible = $state(false);
  let pos = $state({ x: 0, y: 0, below: true });
  let tipEl: HTMLDivElement | undefined = $state();
  let target: HTMLElement | null = null;
  let timer: number | undefined;

  function tipOf(el: HTMLElement): string {
    const t = el.getAttribute("title");
    if (t) {
      // Take over the native tooltip (also after Svelte re-sets the attribute).
      el.dataset.tip = t;
      el.removeAttribute("title");
    }
    return el.dataset.tip ?? "";
  }

  function place() {
    if (!target || !tipEl) return;
    const r = target.getBoundingClientRect();
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    const below = r.bottom + h + 10 < innerHeight;
    const x = Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const y = below ? r.bottom + 8 : r.top - h - 8;
    pos = { x, y, below };
  }

  function show(el: HTMLElement) {
    const t = tipOf(el);
    if (!t) return;
    target = el;
    clearTimeout(timer);
    // Moving between neighbouring controls while a tooltip is open switches instantly.
    timer = window.setTimeout(async () => {
      text = t;
      visible = true;
      await Promise.resolve();
      requestAnimationFrame(place);
    }, visible ? 0 : 450);
  }

  function hide() {
    clearTimeout(timer);
    target = null;
    timer = window.setTimeout(() => (visible = false), 60);
  }

  onMount(() => {
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[title], [data-tip]");
      if (el === target) return;
      if (el) show(el);
      else if (target) hide();
    };
    const out = (e: MouseEvent) => {
      if (!target) return;
      const to = e.relatedTarget as Node | null;
      if (!to || !target.contains(to)) hide();
    };
    const down = () => {
      clearTimeout(timer);
      visible = false;
      target = null;
    };
    document.addEventListener("mouseover", over, true);
    document.addEventListener("mouseout", out, true);
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", down, true);
    document.addEventListener("wheel", down, { capture: true, passive: true });
    return () => {
      document.removeEventListener("mouseover", over, true);
      document.removeEventListener("mouseout", out, true);
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("wheel", down, true);
    };
  });
</script>

{#if visible && text}
  <div class="tip" class:above={!pos.below} bind:this={tipEl} style="left: {pos.x}px; top: {pos.y}px" role="tooltip">{text}</div>
{/if}

<style>
  .tip {
    position: fixed;
    z-index: 200;
    width: max-content;
    max-width: 380px;
    padding: 6px 12px;
    border-radius: 14px;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.35;
    color: var(--label);
    background: var(--tooltip-bg);
    backdrop-filter: var(--blur);
    box-shadow: var(--tooltip-shadow);
    pointer-events: none;
    white-space: normal;
    overflow-wrap: anywhere;
    /* No open animation: fading/scaling glass (backdrop-filter) makes WebKitGTK flash. */
    transform-origin: top center;
  }
  .tip.above { transform-origin: bottom center; }
  @keyframes tipIn {
    from { opacity: 0; transform: translateY(-3px) scale(0.96); }
  }
  .tip.above { animation-name: tipInUp; }
  @keyframes tipInUp {
    from { opacity: 0; transform: translateY(3px) scale(0.96); }
  }
</style>
