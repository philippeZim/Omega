<script lang="ts">
  import TreeNode from "../TreeNode.svelte";
  import RemoteTree from "../RemoteTree.svelte";
  import { app, openFolder, setRoot, createEntry } from "../../lib/state.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { basename } from "../../lib/api";
  import { t } from "../../lib/i18n/index.svelte";
  import { collab } from "../../lib/collab/collab.svelte";
  import { share, remoteCreate } from "../../lib/collab/share.svelte";
  import { fileDrag } from "../../lib/fileDrag.svelte";
  import { shortcutLabel } from "../../lib/commands.svelte";
  import { externalDrop, listenExternalDrops, pasteInto } from "../../lib/fileImport.svelte";
  import { onMount } from "svelte";

  // Files dragged in from a file manager are copied into the folder under the pointer (#299).
  onMount(listenExternalDrops);

  // Ctrl+V on the empty area of the tree pastes into the project folder.
  function treeKey(e: KeyboardEvent) {
    if (e.target !== e.currentTarget || !app.root) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === "v") {
      e.preventDefault();
      e.stopPropagation();
      pasteInto(app.root);
    }
  }

  const guestView = $derived(collab.role === "guest" && collab.status === "connected");

  async function newEntry(dir: boolean) {
    if (!app.root) return;
    const name = await ui.prompt(dir ? t("app.newFolder") : t("app.newFile"), "", dir ? t("app.folderNamePlaceholder") : t("app.fileNamePlaceholder"));
    if (!name) return;
    await createEntry(app.root, name, dir);
  }

  // Empty area of the guest's tree: the only mouse path in an empty project.
  function guestRootMenu(e: MouseEvent) {
    if (!share.hostHasRoot) return;
    ui.openMenu(e, [
      { label: t("app.newFile"), action: () => remoteCreate("", false) },
      { label: t("app.newFolder"), action: () => remoteCreate("", true) },
      { separator: true, label: "" },
      { label: t("app.refresh"), action: () => share.treeGen++ },
    ]);
  }

  function rootMenu(e: MouseEvent) {
    if (!app.root) return;
    ui.openMenu(e, [
      { label: t("app.newFile"), action: () => newEntry(false) },
      { label: t("app.newFolder"), action: () => newEntry(true) },
      { label: t("app.import.paste"), action: () => pasteInto(app.root!) },
      { separator: true, label: "" },
      { label: t("app.refresh"), action: () => app.treeVersion++ },
      { label: t("app.closeFolder"), action: () => setRoot(null) },
    ]);
  }
</script>

<div class="files">
  {#if guestView}
    <div class="head">
      <span class="label" title={share.hostRoot || undefined}>{t("app.hostLabel", { name: share.hostRoot || t("app.project") })}</span>
      {#if share.hostHasRoot}
        <div class="actions">
          <button title={t("app.newFile")} onclick={() => remoteCreate("", false)} aria-label={t("app.newFile")}>
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
          <button title={t("app.newFolder")} onclick={() => remoteCreate("", true)} aria-label={t("app.newFolder")}>
            <svg width="15" height="14" viewBox="0 0 15 14"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.3 1.5h5.7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
        </div>
      {/if}
    </div>
    <div class="tree" role="tree" tabindex="-1" oncontextmenu={guestRootMenu}>
      <RemoteTree />
    </div>
  {:else if app.root}
    <div class="head">
      <!-- Full path on hover: long names are cut off (#40). -->
      <span class="label" title={app.root}>{basename(app.root)}</span>
      <div class="actions">
        <button title={t("app.newFile")} onclick={() => newEntry(false)} aria-label={t("app.newFile")}>
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <button title={t("app.newFolder")} onclick={() => newEntry(true)} aria-label={t("app.newFolder")}>
          <svg width="15" height="14" viewBox="0 0 15 14"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.3 1.5h5.7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      </div>
    </div>
    <div class="tree" class:drop-target={(fileDrag.from && fileDrag.target === app.root) || externalDrop.target === app.root} role="tree" tabindex="-1" oncontextmenu={rootMenu} onkeydown={treeKey}
      data-tree-path={app.root} data-tree-dir="1">
      {#key app.treeVersion}
        <TreeNode path={app.root} depth={0} root />
      {/key}
    </div>
  {:else}
    <div class="empty">
      <p>{t("app.noFolderOpen")}</p>
      <button class="btn primary" onclick={openFolder}>{t("app.openFolder")}</button>
      {#if shortcutLabel("file.openFolder")}<span class="hint">{shortcutLabel("file.openFolder")}</span>{/if}
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
