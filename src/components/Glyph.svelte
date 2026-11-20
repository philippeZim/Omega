<script lang="ts">
  /** Geometrically centred stroke icons for small buttons (text glyphs like × or + sit off-centre depending on the font). */
  let { name, size = 10, stroke = 1.6 }: { name: "x" | "plus" | "minus" | "chevron" | "chevron-down" | "check"; size?: number; stroke?: number } = $props();
</script>

<svg class="glyph" style="--glyph-stroke: {stroke}" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
  {#if name === "x"}
    <path d="M2 2l6 6M8 2l-6 6" />
  {:else if name === "plus"}
    <path d="M5 1v8M1 5h8" />
  {:else if name === "chevron"}
    <path d="M3.5 1.5L7 5l-3.5 3.5" />
  {:else if name === "check"}
    <path d="M1.5 5.2L4 7.6 8.5 2.6" />
  {:else if name === "chevron-down"}
    <path d="M1.5 3.5L5 7l3.5-3.5" />
  {:else}
    <path d="M1 5h8" />
  {/if}
</svg>

<style>
  .glyph { display: block; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: var(--glyph-stroke); stroke-linecap: round; }
</style>
