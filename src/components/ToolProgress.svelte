<script lang="ts">
  import { toolState } from "../lib/tools.svelte";
  import { t } from "../lib/i18n/index.svelte";

  const items = $derived(Object.entries(toolState.installing));
  const stage = (s: string) => (s === "extract" ? t("tools.extracting") : s === "install" ? t("tools.installing") : t("tools.downloading"));
  const mb = (n: number) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1);
</script>

{#if items.length}
  <div class="tool-progress">
    {#each items as [id, p] (id)}
      <div class="item">
        <div class="row">
          <span class="name">{stage(p.stage)} · {p.label}</span>
          <span class="size">{p.done ? `${mb(p.done)}${p.total ? ` / ${mb(p.total)}` : ""} MB` : ""}</span>
        </div>
        <div class="bar" class:indeterminate={!p.total || p.stage !== "download"}>
          <div class="fill" style="width: {p.total && p.stage === 'download' ? Math.min(100, (p.done / p.total) * 100) : 100}%"></div>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .tool-progress {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 121;
    width: min(320px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 14px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    font-size: 12px;
  }
  .row { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .size { opacity: 0.6; font-variant-numeric: tabular-nums; }
  .bar { height: 4px; border-radius: 2px; background: rgba(127, 127, 127, 0.25); overflow: hidden; }
  .fill { height: 100%; background: var(--accent, #6b9be0); transition: width 0.2s; }
  .indeterminate .fill { width: 35% !important; animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
</style>
