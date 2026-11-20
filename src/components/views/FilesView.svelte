<script lang="ts">
  import TreeNode from "../TreeNode.svelte";
  import RemoteTree from "../RemoteTree.svelte";
  import { app, openFolder, setRoot, openFile } from "../../lib/state.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { fsApi, joinPath, basename } from "../../lib/api";
  import { t } from "../../lib/i18n/index.svelte";
  import { collab } from "../../lib/collab/collab.svelte";
  import { share } from "../../lib/collab/share.svelte";
  import { fileDrag } from "../../lib/fileDrag.svelte";

  const guestView = $derived(collab.role === "guest" && collab.status === "connected");

  async function newEntry(dir: boolean) {
    if (!app.root) return;
    const name = await ui.prompt(dir ? t("app.newFolder") : t("app.newFile"), "", dir ? t("app.folderNamePlaceholder") : t("app.fileNamePlaceholder"));
    if (!name) return;
    const p = joinPath(app.root, name);
    try {
      if (dir) await fsApi.createDir(p);
      else await fsApi.createFile(p);
      app.treeVersion++;
      if (!dir) openFile(p);
    } catch (e) {
      ui.toast(!dir && (await fsApi.exists(p)) ? t("code.existsAlready", { name }) : String(e), "error");
    }
  }

  function rootMenu(e: MouseEvent) {
    if (!app.root) return;
    ui.openMenu(e, [
      { label: t("app.newFile"), action: () => newEntry(false) },
      { label: t("app.newFolder"), action: () => newEntry(true) },
      { separator: true, label: "" },
      { label: t("app.refresh"), action: () => app.treeVersion++ },
      { label: t("app.closeFolder"), action: () => setRoot(null) },
    ]);
  }
</script>

<div class="files">
  {#if guestView}
    <div class="head">
      <span class="label">{t("app.hostLabel", { name: share.hostRoot || t("app.project") })}</span>
    </div>
    <div class="tree" role="tree">
      <RemoteTree />
    </div>
  {:else if app.root}
    <div class="head">
      <span class="label">{basename(app.root)}</span>
      <div class="actions">
        <button title={t("app.newFile")} onclick={() => newEntry(false)} aria-label={t("app.newFile")}>
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <button title={t("app.newFolder")} onclick={() => newEntry(true)} aria-label={t("app.newFolder")}>
          <svg width="15" height="14" viewBox="0 0 15 14"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.3 1.5h5.7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      </div>
    </div>
    <div class="tree" class:drop-target={fileDrag.from && fileDrag.target === app.root} role="tree" tabindex="-1" oncontextmenu={rootMenu}
      data-tree-path={app.root} data-tree-dir="1">
      {#key app.treeVersion}
        <TreeNode path={app.root} depth={0} root />
      {/key}
    </div>
  {:else}
    <div class="empty">
      <p>{t("app.noFolderOpen")}</p>
      <button class="btn primary" onclick={openFolder}>{t("app.openFolder")}</button>
      <span class="hint">{t("app.ctrl")}+O</span>
    </div>
  {/if}
</div>

{#if fileDrag.from}
  <div class="ghost" style="left: {fileDrag.x + 12}px; top: {fileDrag.y + 10}px">{basename(fileDrag.from)}</div>
{/if}

<style>
  .files { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 12px 8px 20px;
  }
  .label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--label-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions { display: flex; gap: 2px; }
  .actions button {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--label-2);
  }
  .actions button:hover { background: var(--fill-hover); color: var(--label); }
  .tree { flex: 1; overflow: auto; padding: 2px 10px 20px; outline: none; }
  .tree.drop-target { background: color-mix(in srgb, var(--accent) 8%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); border-radius: 12px; }
  .ghost { position: fixed; z-index: 1000; pointer-events: none; padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow), 0 8px 24px rgba(0, 0, 0, 0.35); white-space: nowrap; }
  :global(body.file-dragging), :global(body.file-dragging *) { cursor: grabbing !important; user-select: none !important; }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--label-2);
  }
  .empty p { margin: 0; }
  .hint { font-size: 11px; color: var(--label-3); }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
</style>
