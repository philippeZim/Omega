<script lang="ts">
  import { activeTab, isRemotePath, type Tab } from "../lib/state.svelte";
  import { openLanguageMenu } from "../lib/code/langMenu";
  import { effectiveLang, overrideFor } from "../lib/code/langOverride.svelte";
  import { statusFor } from "../lib/code/lsp.svelte";
  import { t, type Key } from "../lib/i18n/index.svelte";
  import LspDot from "./LspDot.svelte";

  /** The active file's language and server state in Code mode; a click opens the menu for both. */
  /** `tab`: the file of this editor group (#219); by default the active one. */
  let { compact = false, tab }: { compact?: boolean; tab?: Tab | null } = $props();
  const shown = $derived(tab === undefined ? activeTab() : tab);

  const path = $derived(shown?.path ?? null);
  // A large file has no language features; a click on the picker says why (#174).
  const large = $derived(!!shown?.large);
  const lang = $derived(large ? null : effectiveLang(path));
  const chosen = $derived(!large && !!overrideFor(path));
  const text = $derived(lang?.label ?? t("code.lang.plain"));
  const st = $derived(statusFor(lang, path));
  const head = $derived(
    st.status ? t("code.lsp.statusTitle", { kind: lang?.server ?? "", status: t(`code.lsp.st.${st.status}` as Key) }) : "",
  );
  const langTitle = $derived(large ? t("code.large.noLang") : chosen ? t("code.lang.titleChosen", { lang: text }) : t("code.lang.title", { lang: text }));
  const title = $derived([langTitle, head, st.message?.trim()].filter(Boolean).join("\n"));
  const label = $derived(head ? `${text}. ${head}` : langTitle);

  function open(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openLanguageMenu(r.left, r.bottom + 8);
  }
</script>

{#if path && !isRemotePath(path)}
  <div class="gcap cap">
    <button class="gbtn neutral pick" class:chosen {title} aria-label={label} aria-haspopup="menu" onclick={open}>
      {#if st.status}<LspDot status={st.status} />{/if}
      <span class="txt" class:compact>{text}</span>
    </button>
  </div>
{/if}

<style>
  .cap { margin-left: 8px; flex-shrink: 0; }
  .pick { gap: 6px; padding: 0 11px; font-weight: 500; }
  .txt { color: var(--label-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px; }
  .txt.compact { max-width: 56px; }
  .chosen .txt { color: var(--label); }
</style>
