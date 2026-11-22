<script lang="ts">
  import ImageView from "./ImageView.svelte";
  import PdfView from "./PdfView.svelte";
  import { openViewerAsText, syncFromDisk, type Tab } from "../lib/state.svelte";
  import { share } from "../lib/collab/share.svelte";
  import { loadViewerData, type ViewerData } from "../lib/viewerData";
  import { isSvgPath } from "../lib/viewer";
  import { t } from "../lib/i18n/index.svelte";

  let { tab }: { tab: Tab } = $props();

  let data = $state.raw<ViewerData | null>(null);
  let error = $state<string | null>(null);
  let seq = 0;

  $effect(() => {
    const path = tab.viewOf!;
    const kind = tab.viewer!;
    void tab.viewRev;
    // A guest has no file watcher: the host's file changes arrive as a new tree generation.
    if (path.startsWith("collab:")) void share.treeGen;
    const mine = ++seq;
    loadViewerData(path, kind).then(
      (d) => {
        if (mine !== seq) return;
        data = d;
        error = null;
      },
      (e) => {
        if (mine !== seq) return;
        data = null;
        error = String(e);
      },
    );
    return () => void seq++;
  });

  const svg = $derived(isSvgPath(tab.viewOf!));
</script>

<div class="viewer">
  {#if error}
    <div class="message" role="alert">
      <p>{error}</p>
      {#if svg}<button class="btn" onclick={() => openViewerAsText(tab.id)}>{t("app.viewer.openAsText")}</button>{/if}
    </div>
  {:else if !data}
    <div class="message"><p>{t("app.viewer.loading")}</p></div>
  {:else if tab.viewer === "image"}
    <ImageView {data} path={tab.viewOf!} onText={svg ? () => openViewerAsText(tab.id) : null} />
  {:else if data.file}
    <PdfView source={data.file} onReadFailed={() => syncFromDisk([tab.viewOf!])} />
  {/if}
</div>

<style>
  .viewer { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .message { margin: auto; max-width: 420px; padding: 16px; display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; color: var(--label-2); }
  .message p { margin: 0; }
</style>
