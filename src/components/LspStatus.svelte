<script lang="ts">
  import { activeTab } from "../lib/state.svelte";
  import { langFor } from "../lib/code/languages";
  import { statusFor } from "../lib/code/lsp.svelte";
  import { restartLanguageServer } from "../lib/code/lspExtension";
  import { t, type Key } from "../lib/i18n/index.svelte";

  /** Language server state of the active file, with restart (or install) on click. */
  let { compact = false }: { compact?: boolean } = $props();

  const path = $derived(activeTab()?.path ?? null);
  const lang = $derived(langFor(path));
  const st = $derived(statusFor(lang, path));
  const busy = $derived(st.status === "starting" || st.status === "installing");
  const label = $derived(st.status ? t(`code.lsp.st.${st.status}` as Key) : "");
  const head = $derived(t("code.lsp.statusTitle", { kind: lang?.server ?? "", status: label }));
  const title = $derived(
    [
      head,
      st.message?.trim(),
      busy ? "" : t(st.status === "missing" ? "code.lsp.install" : "code.lsp.restart"),
    ].filter(Boolean).join("\n"),
  );
</script>

{#if lang?.server && path && st.status}
  <div class="gcap cap">
    <button class="gbtn neutral lsp {st.status}" {title} aria-label={head} disabled={busy} onclick={() => restartLanguageServer(lang, path)}>
      <span class="dot"></span>
      {#if !compact}<span class="txt">{lang.server}</span>{/if}
    </button>
  </div>
{/if}

<style>
  .cap { margin-left: 8px; flex-shrink: 0; }
  .lsp { gap: 6px; padding: 0 11px 0 10px; font-weight: 500; }
  .lsp:disabled { cursor: default; }
  .txt { color: var(--label-2); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--label-2); flex-shrink: 0; }
  .ready .dot { background: var(--green, #4caf50); }
  .error .dot, .stopped .dot { background: var(--red, #e5534b); }
  .missing .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--label-2); }
  .starting .dot, .installing .dot { background: var(--orange, #e0a030); animation: pulse 1s ease-in-out infinite alternate; }
  @keyframes pulse { from { background-color: var(--label-3); } }
</style>
