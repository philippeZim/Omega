<script lang="ts">
  import TreeNode from "./TreeNode.svelte";
  import { app, openFolder, setRoot, openFile } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import { fsApi, joinPath, basename } from "../lib/api";
  import { latex } from "../lib/latex/controller.svelte";
  import * as ed from "../lib/editor";

  import ChangesPanel from "./ChangesPanel.svelte";
  import RemoteTree from "./RemoteTree.svelte";
  import { collab } from "../lib/collab/collab.svelte";
  import { share } from "../lib/collab/share.svelte";
  const guestView = $derived(collab.role === "guest" && collab.status === "connected");
  import { git, refresh as gitRefresh } from "../lib/git/git.svelte";

  const showOutline = $derived(app.mode === "latex" && app.sidebarView === "outline");
  const showChanges = $derived(app.sidebarView === "changes");
  $effect(() => {
    if (app.sidebarView === "outline" && app.mode !== "latex") app.sidebarView = "files";
  });

  function gotoPos(pos: number) {
    const v = ed.getView();
    if (!v) return;
    v.dispatch({ selection: { anchor: Math.min(pos, v.state.doc.length) }, scrollIntoView: true });
    v.focus();
  }

  let width = $state(Number(localStorage.getItem("sidebarWidth")) || 250);

  async function newEntry(dir: boolean) {
    if (!app.root) return;
    const name = await ui.prompt(dir ? "Neuer Ordner" : "Neue Datei", "", dir ? "ordnername" : "datei.txt");
    if (!name) return;
    const p = joinPath(app.root, name);
    try {
      if (dir) await fsApi.createDir(p);
      else await fsApi.writeFile(p, "");
      app.treeVersion++;
      if (!dir) openFile(p);
    } catch (e) {
      ui.toast(String(e), "error");
    }
  }

  function startResize(e: PointerEvent) {
    const startX = e.clientX, startW = width;
    const move = (ev: PointerEvent) => (width = Math.min(520, Math.max(170, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("sidebarWidth", String(width));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function rootMenu(e: MouseEvent) {
    if (!app.root) return;
    ui.openMenu(e, [
      { label: "Neue Datei", action: () => newEntry(false) },
      { label: "Neuer Ordner", action: () => newEntry(true) },
      { separator: true, label: "" },
      { label: "Aktualisieren", action: () => app.treeVersion++ },
      { label: "Ordner schließen", action: () => setRoot(null) },
    ]);
  }
</script>

<aside class="sidebar glass" style="width: {width}px">
  <div class="switch" style="--n: {app.mode === 'latex' ? 3 : 2}">
    <button class:on={app.sidebarView === "files"} onclick={() => (app.sidebarView = "files")}>Dateien</button>
    <button class:on={showChanges} onclick={() => { app.sidebarView = "changes"; gitRefresh(); }}>
      Änderungen{#if git.changes.length}<span class="count">{git.changes.length}</span>{/if}
    </button>
    {#if app.mode === "latex"}
      <button class:on={showOutline} onclick={() => (app.sidebarView = "outline")}>Gliederung</button>
    {/if}
  </div>
  {#if guestView && app.sidebarView === "files"}
    <div class="head">
      <span class="label">Host · {share.hostRoot || "Projekt"}</span>
    </div>
    <div class="tree" role="tree">
      <RemoteTree />
    </div>
  {:else if showChanges}
    <ChangesPanel />
  {:else if showOutline}
    <div class="outline">
      {#each latex.outline as item, i (i)}
        <button class="oitem" style="padding-left: {12 + Math.max(0, item.level - 1) * 14}px" class:top={item.level <= 2} onclick={() => gotoPos(item.pos)}>
          <span class="otitle">{item.title}</span>
          <span class="oline">{item.line}</span>
        </button>
      {:else}
        <p class="hint" style="padding: 16px">Keine Abschnitte (\section{"{…}"}) gefunden.</p>
      {/each}
    </div>
  {:else if app.root}
    <div class="head">
      <span class="label">{basename(app.root)}</span>
      <div class="actions">
        <button title="Neue Datei" onclick={() => newEntry(false)} aria-label="Neue Datei">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <button title="Neuer Ordner" onclick={() => newEntry(true)} aria-label="Neuer Ordner">
          <svg width="15" height="14" viewBox="0 0 15 14"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.3 1.5h5.7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      </div>
    </div>
    <div class="tree" role="tree" tabindex="-1" oncontextmenu={rootMenu}>
      {#key app.treeVersion}
        <TreeNode path={app.root} depth={0} root />
      {/key}
    </div>
  {:else}
    <div class="empty">
      <p>Kein Ordner geöffnet</p>
      <button class="btn primary" onclick={openFolder}>Ordner öffnen</button>
      <span class="hint">Strg+O</span>
    </div>
  {/if}
  <div class="resizer" role="separator" onpointerdown={startResize}></div>
</aside>

<style>
  .sidebar {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }
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
  .switch {
    display: grid;
    grid-template-columns: repeat(var(--n), 1fr);
    margin: 12px 12px 0;
    padding: 3px;
    border-radius: 999px;
    background: var(--recess);
    box-shadow: var(--recess-shadow);
  }
  .switch button { height: 26px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--label-2); }
  .count { margin-left: 5px; padding: 0 5px; border-radius: 999px; font-size: 10px; background: rgba(255, 255, 255, 0.14); }
  .switch button.on { background: rgba(255, 255, 255, 0.14); color: var(--label); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12); }
  .outline { flex: 1; overflow: auto; padding: 10px 10px 20px; }
  .oitem { width: 100%; display: flex; gap: 8px; align-items: center; height: 30px; padding-right: 10px; border-radius: 10px; text-align: left; color: var(--label-2); }
  .oitem.top { color: var(--label); font-weight: 600; }
  .oitem:hover { background: var(--fill-hover); }
  .otitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .oline { font-size: 11px; color: var(--label-3); font-family: var(--mono); }
  .resizer {
    position: absolute;
    right: -6px;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 5;
  }
</style>
