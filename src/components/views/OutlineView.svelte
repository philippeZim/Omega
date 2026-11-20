<script lang="ts">
  import { latex } from "../../lib/latex/controller.svelte";
  import * as ed from "../../lib/editor";
  import { t } from "../../lib/i18n/index.svelte";

  function gotoPos(pos: number) {
    const v = ed.getView();
    if (!v) return;
    v.dispatch({ selection: { anchor: Math.min(pos, v.state.doc.length) }, scrollIntoView: true });
    v.focus();
  }
</script>

  <div class="outline">
    {#each latex.outline as item, i (i)}
      <button class="oitem" style="padding-left: {12 + Math.max(0, item.level - 1) * 14}px" class:top={item.level <= 2} title={item.title} onclick={() => gotoPos(item.pos)}>
        <span class="otitle">{item.title}</span>
        <span class="oline">{item.line}</span>
      </button>
    {:else}
      <p class="hint" style="padding: 16px">{t("app.noSections")}</p>
    {/each}
  </div>

<style>
  .hint { font-size: 11px; color: var(--label-3); }
  .outline { flex: 1; overflow: auto; padding: 10px 10px 20px; }
  .oitem { width: 100%; display: flex; gap: 8px; align-items: center; height: 30px; padding-right: 10px; border-radius: 10px; text-align: left; color: var(--label-2); }
  .oitem.top { color: var(--label); font-weight: 600; }
  .oitem:hover { background: var(--fill-hover); }
  .otitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .oline { font-size: 11px; color: var(--label-3); font-family: var(--mono); }
</style>
