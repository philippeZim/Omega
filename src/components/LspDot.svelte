<script lang="ts">
  import type { ServerStatus } from "../lib/code/lsp.svelte";

  /** Language server state as a coloured dot (language button and its menu). */
  let { status }: { status: ServerStatus } = $props();
</script>

<span class="dot {status}" aria-hidden="true"></span>

<style>
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--label-2); flex-shrink: 0; }
  .ready { background: var(--green, #4caf50); }
  .error, .stopped { background: var(--red, #e5534b); }
  .missing { background: transparent; box-shadow: inset 0 0 0 1.5px var(--label-2); }
  .starting, .installing { background: var(--orange, #e0a030); animation: pulse 1s ease-in-out infinite alternate; }
  @keyframes pulse { from { background-color: var(--label-3); } }
</style>
