<script lang="ts">
  import { ui } from "../lib/ui.svelte";
</script>

<div class="toasts">
  {#each ui.toasts as t (t.id)}
    <div class="toast" class:error={t.kind === "error"}>{t.text}</div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: 66px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 120;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    pointer-events: none;
  }
  .toast {
    padding: 9px 16px;
    border-radius: 20px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    font-size: 12.5px;
    max-width: 520px;
    /* No open animation: fading/scaling glass (backdrop-filter) makes WebKitGTK flash. */
  }
  .toast.error { color: #e3aaa4; }
  @keyframes drop { from { opacity: 0; transform: translateY(-10px); } }
</style>
