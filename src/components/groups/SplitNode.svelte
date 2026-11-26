<script lang="ts">
  import SplitNode from "./SplitNode.svelte";
  import EditorGroup from "./EditorGroup.svelte";
  import type { LayoutNode } from "../../lib/editorGroups";
  import { t } from "../../lib/i18n/index.svelte";

  /** A node of the editor group layout (#219): a group, or a row/column of nodes with resizers between. */
  let { node }: { node: LayoutNode } = $props();

  /** Smallest share a child can be resized to, in px. */
  const MIN_PX = 160;
  let el = $state<HTMLElement | null>(null);

  function startResize(e: PointerEvent, i: number) {
    if (!("dir" in node) || !el) return;
    e.preventDefault();
    const n = node;
    const row = n.dir === "row";
    const total = row ? el.clientWidth : el.clientHeight;
    const start = row ? e.clientX : e.clientY;
    const a = n.sizes[i], b = n.sizes[i + 1];
    const min = Math.min(MIN_PX / Math.max(total, 1), (a + b) / 2);
    const move = (ev: PointerEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / Math.max(total, 1);
      const na = Math.min(Math.max(a + d, min), a + b - min);
      n.sizes[i] = na;
      n.sizes[i + 1] = a + b - na;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

{#if "group" in node}
  <EditorGroup gid={node.group} />
{:else}
  <div class="split" class:row={node.dir === "row"} bind:this={el}>
    {#each node.children as child, i ("group" in child ? child.group : `s${i}`)}
      {#if i > 0}
        <div class="resizer" role="separator" aria-orientation={node.dir === "row" ? "vertical" : "horizontal"} aria-label={t("app.groupResize")} onpointerdown={(e) => startResize(e, i - 1)}></div>
      {/if}
      <div class="cell" style:flex-grow={node.sizes[i]}>
        <SplitNode node={child} />
      </div>
    {/each}
  </div>
{/if}

<style>
  .split { flex: 1; min-width: 0; min-height: 0; height: 100%; display: flex; flex-direction: column; gap: var(--gap); }
  .split.row { flex-direction: row; }
  .cell { flex-basis: 0; min-width: 0; min-height: 0; display: flex; position: relative; }
  .resizer { flex: 0 0 0; position: relative; z-index: 5; }
  .resizer::before { content: ""; position: absolute; }
  .split.row > .resizer::before { top: 0; bottom: 0; left: calc(var(--gap) / -2 - 3px); width: 6px; cursor: col-resize; }
  .split:not(.row) > .resizer::before { left: 0; right: 0; top: calc(var(--gap) / -2 - 3px); height: 6px; cursor: row-resize; }
  /* The gap is in the flex layout; the resizer itself takes no space. */
  .split > .resizer { margin: 0 calc(var(--gap) / -2); }
  .split:not(.row) > .resizer { margin: calc(var(--gap) / -2) 0; }
</style>
