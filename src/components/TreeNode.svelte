<script lang="ts" module>
  // Expanded folders survive tree reloads (treeVersion bumps).
  const expanded = new Set<string>(JSON.parse(localStorage.getItem("expanded") || "[]"));
  const persist = () => localStorage.setItem("expanded", JSON.stringify([...expanded]));
</script>

<script lang="ts">
  import { fsChanges } from "../lib/fsWatch.svelte";
  import TreeNode from "./TreeNode.svelte";
  import { untrack } from "svelte";
  import { fsApi, joinPath, dirname, basename, type Entry } from "../lib/api";
  import { app, openFile, pathMoved, activeTab, inRoot } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import { git, kind } from "../lib/git/git.svelte";
  import { t } from "../lib/i18n/index.svelte";
  import { fileDrag, startFileDrag } from "../lib/fileDrag.svelte";

  const gitKind = $derived.by(() => {
    if (!git.repo || !git.top || !path.startsWith(git.top + "/")) return null;
    const rel = path.slice(git.top.length + 1);
    if (isDir) return git.changes.some((c) => c.path.startsWith(rel + "/")) ? "dir" : null;
    const c = git.changes.find((x) => x.path === rel);
    return c ? kind(c) : null;
  });

  let { path, depth, root = false, entry = null }: { path: string; depth: number; root?: boolean; entry?: Entry | null } = $props();

  let open = $state(untrack(() => root || expanded.has(path)));
  let children = $state<Entry[] | null>(null);
  const isDir = $derived(root || entry?.is_dir);
  const active = $derived(activeTab()?.path === path);

  async function load() {
    try {
      children = await fsApi.listDir(path);
    } catch (e) {
      children = [];
      ui.toast(String(e), "error");
    }
  }

  $effect(() => {
    if (open && isDir && children === null) load();
  });

  // Reload this folder's listing when something was created/removed/renamed in it from outside.
  $effect(() => {
    fsChanges.seq;
    untrack(() => {
      if (isDir && children !== null && fsChanges.dirs.includes(path)) load();
    });
  });

  const dropTarget = $derived(!root && isDir && fileDrag.target === path);
  const dragging = $derived(fileDrag.from === path);

  // Hovering a closed folder while dragging opens it after a moment.
  $effect(() => {
    if (!dropTarget || open) return;
    const id = setTimeout(() => {
      open = true;
      expanded.add(path);
      persist();
    }, 600);
    return () => clearTimeout(id);
  });

  function toggle() {
    if (!isDir) return openFile(path);
    open = !open;
    if (open) expanded.add(path);
    else expanded.delete(path);
    persist();
  }

  async function create(dir: boolean) {
    const name = await ui.prompt(dir ? t("app.newFolder") : t("app.newFile"), "", dir ? t("app.folderNamePlaceholder") : t("app.fileNamePlaceholder"));
    if (!name) return;
    const p = joinPath(path, name);
    try {
      if (dir) await fsApi.createDir(p);
      else await fsApi.writeFile(p, "");
      expanded.add(path);
      persist();
      app.treeVersion++;
      if (!dir) openFile(p);
    } catch (e) {
      ui.toast(String(e), "error");
    }
  }

  async function rename() {
    const name = basename(path);
    const dot = name.lastIndexOf(".");
    const next = await ui.prompt(t("common.rename"), name, "", dot > 0 ? dot : undefined);
    if (!next || next === name) return;
    const to = joinPath(dirname(path), next);
    try {
      await fsApi.rename(path, to);
      pathMoved(path, to);
    } catch (e) {
      ui.toast(String(e), "error");
    }
  }

  async function remove() {
    const ok = await ui.confirm(t("app.deleteConfirm", { name: basename(path) }), t("app.cannotUndo"), t("common.delete"), true);
    if (!ok) return;
    try {
      await fsApi.remove(path);
      pathMoved(path, null);
    } catch (e) {
      ui.toast(String(e), "error");
    }
  }

  function menu(e: MouseEvent) {
    if (root) return;
    ui.openMenu(e, [
      ...(isDir
        ? [
            { label: t("app.newFile"), action: () => create(false) },
            { label: t("app.newFolder"), action: () => create(true) },
            { separator: true, label: "" },
          ]
        : [{ label: t("common.open"), action: () => openFile(path) }, { separator: true, label: "" }]),
      { label: t("common.rename"), action: rename },
      { label: t("app.copyPath"), action: () => navigator.clipboard.writeText(path) },
      ...(app.root && inRoot(path, app.root) && path !== app.root
        ? [{ label: t("app.copyRelativePath"), action: () => navigator.clipboard.writeText(path.slice(app.root!.replace(/\/$/, "").length + 1)) }]
        : []),
      { separator: true, label: "" },
      { label: t("common.delete"), action: remove, danger: true },
    ]);
  }
</script>

{#if !root}
  <button class="row" class:active style="padding-left: {8 + (depth - 1) * 14}px" class:drop-target={dropTarget} class:dragging data-tree-path={path} data-tree-dir={isDir ? "1" : "0"}
    onpointerdown={(e) => startFileDrag(e, path)} onclick={toggle} oncontextmenu={menu} role="treeitem" aria-selected={active} aria-expanded={isDir ? open : undefined}>
    {#if isDir}
      <svg class="chev" class:open width="10" height="10" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    {:else}
      <span class="dot"></span>
    {/if}
    <span class="name git-{gitKind}" class:dir={isDir}>{entry?.name}</span>
  </button>
{/if}

{#if isDir && open && children}
  {#each children as c (c.path)}
    <TreeNode path={c.path} entry={c} depth={depth + 1} />
  {/each}
{/if}

<style>
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding-right: 10px;
    border-radius: 10px;
    text-align: left;
    color: var(--label);
    font-size: 13px;
  }
  .row:hover { background: var(--fill-hover); }
  .row.active { background: rgba(var(--fg-rgb), 0.1); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.06); }
  .row.drop-target { background: color-mix(in srgb, var(--accent) 18%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 50%, transparent); }
  .row.dragging { opacity: 0.45; }
  .chev { flex-shrink: 0; color: var(--label-2);  }
  .chev.open { transform: rotate(90deg); }
  .dot { width: 10px; flex-shrink: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name.dir { font-weight: 500; }
  .name.git-new { color: var(--green); }
  .name.git-modified, .name.git-renamed, .name.git-dir { color: var(--accent); }
  .name.git-conflict { color: var(--red); }
</style>
