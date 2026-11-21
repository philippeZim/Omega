<script lang="ts">
  import { activeTab, isRemotePath } from "../lib/state.svelte";
  import { openLanguageMenu } from "../lib/code/langMenu";
  import { effectiveLang, overrideFor } from "../lib/code/langOverride.svelte";
  import { t } from "../lib/i18n/index.svelte";

  /** The active file's language in Code mode; a click chooses another one for this file. */
  let { compact = false }: { compact?: boolean } = $props();

  const path = $derived(activeTab()?.path ?? null);
  const lang = $derived(effectiveLang(path));
  const chosen = $derived(!!overrideFor(path));
  const text = $derived(lang?.label ?? t("code.lang.plain"));
  const title = $derived(chosen ? t("code.lang.titleChosen", { lang: text }) : t("code.lang.title", { lang: text }));

  function open(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openLanguageMenu(r.left, r.bottom + 8);
  }
</script>

{#if path && !isRemotePath(path)}
  <div class="gcap cap">
    <button class="gbtn neutral pick" class:chosen {title} aria-label={title} aria-haspopup="menu" onclick={open}>
      <span class="txt" class:compact>{text}</span>
    </button>
  </div>
{/if}

<style>
  .cap { margin-left: 8px; flex-shrink: 0; }
  .pick { padding: 0 11px; font-weight: 500; }
  .txt { color: var(--label-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px; }
  .txt.compact { max-width: 56px; }
  .chosen .txt { color: var(--label); }
</style>
