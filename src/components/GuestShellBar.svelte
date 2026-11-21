<script lang="ts">
  import { endGuestShell, guestShells, viewGuestShell } from "../lib/collab/guestShell.svelte";
  import { t } from "../lib/i18n/index.svelte";
</script>

<!-- No enter animation: it sits on glass, where WebKitGTK would flash. -->
<div class="bar" role="status" aria-label={t("ai.collab.shell.barLabel")}>
  {#each guestShells.list as s (s.id)}
    <div class="row">
      <span class="dot" style="background: {s.color}"></span>
      <span class="text" title={t("ai.collab.shell.indicator", { name: s.name })}>{t("ai.collab.shell.indicator", { name: s.name })}</span>
      <button onclick={() => viewGuestShell(s.id)}>{t("ai.collab.shell.view")}</button>
      <button class="end" onclick={() => endGuestShell(s.id)}>{t("ai.collab.shell.end")}</button>
    </div>
  {/each}
</div>

<style>
  .bar { position: fixed; left: 14px; bottom: 14px; z-index: 91; display: flex; flex-direction: column; gap: 4px; max-width: min(460px, calc(100vw - 28px)); padding: 6px; border-radius: 16px; background: var(--glass-strong); backdrop-filter: var(--blur); box-shadow: var(--glass-highlight), inset 0 0 0 1px var(--red), 0 10px 30px rgba(0, 0, 0, 0.45); }
  .row { display: flex; align-items: center; gap: 8px; min-width: 0; padding-left: 8px; font-size: 12px; color: var(--label); }
  .dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { flex-shrink: 0; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 11.5px; color: var(--label); background: rgba(var(--fg-rgb), 0.08); }
  button:hover { background: rgba(var(--fg-rgb), 0.16); }
  .end { color: #fff; background: var(--red); }
  .end:hover { background: var(--red); filter: brightness(1.1); }
</style>
