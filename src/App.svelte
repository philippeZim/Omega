<script lang="ts">
  import TopBar from "./components/TopBar.svelte";
  import TabBar from "./components/TabBar.svelte";
  import EditorPane from "./components/EditorPane.svelte";
  import Dialog from "./components/Dialog.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import Toasts from "./components/Toasts.svelte";
  import ToolProgress from "./components/ToolProgress.svelte";
  import HelpPanel from "./components/HelpPanel.svelte";
  import ReportDialog from "./components/ReportDialog.svelte";
  import { report } from "./lib/report.svelte";
  import SettingsPanel from "./components/SettingsPanel.svelte";
  import { settings } from "./lib/settings.svelte";
  import "./lib/power.svelte";
  import DockZone from "./components/DockZone.svelte";
  import DockOverlay from "./components/DockOverlay.svelte";
  import { showView, isOverlay, zoneShown, closeOverlays } from "./lib/layout.svelte";
  import NewProjectDialog from "./components/NewProjectDialog.svelte";
  import CommandPalette from "./components/CommandPalette.svelte";
  import FindInFiles from "./components/FindInFiles.svelte";
  import Tooltip from "./components/Tooltip.svelte";
  import CollabPanel from "./components/CollabPanel.svelte";
  import { collab } from "./lib/collab/collab.svelte";
  import "./lib/collab/share.svelte";
  import "./lib/ai/control.svelte";
  import "./lib/ai/ide.svelte";
  import DiffView from "./components/DiffView.svelte";
  import { diffState, openDiff } from "./lib/git/diff.svelte";
  import { git, refresh as gitRefresh, startGitWatch } from "./lib/git/git.svelte";
  import { setGitGutterHooks, reloadGitHeads } from "./lib/git/gutter";
  import { setBlameRoot, reloadBlame } from "./lib/git/blame.svelte";

  setGitGutterHooks({ root: () => git.top || app.root, menu: (e, items) => ui.openMenu(e, items), showDiff: openDiff });
  setBlameRoot(() => git.top || app.root);
  startGitWatch();
  window.addEventListener("omega:saved", () => gitRefresh());
  $effect(() => {
    void app.root;
    gitRefresh();
  });
  $effect(() => {
    void git.headVersion;
    reloadGitHeads();
    reloadBlame();
  });
  import { find } from "./lib/search/search.svelte";
  import { setConditionHook } from "./lib/debug/editorExt";
  import { handleGlobalKey, palette } from "./lib/commands.svelte";
  import { app } from "./lib/state.svelte";
  import { ui } from "./lib/ui.svelte";
  import { t } from "./lib/i18n/index.svelte";

  setConditionHook((current) => ui.prompt(t("app.breakpointCondition"), current, t("app.breakpointConditionPlaceholder")));

  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { openFile, setRoot } from "./lib/state.svelte";
  import { fsApi } from "./lib/api";

  // `omega <folder|file>…` opens folders as workspace and files as tabs.
  onMount(async () => {
    for (const p of await invoke<string[]>("cli_paths")) {
      try {
        await fsApi.listDir(p);
        setRoot(p);
      } catch {
        if (await fsApi.exists(p)) await openFile(p);
      }
    }
  });


  // Floating side zones close when a file gets opened or the user clicks into the editor column.
  $effect(() => {
    void app.activeId;
    closeOverlays();
  });
  const floating = $derived((isOverlay("left") && zoneShown("left")) || (isOverlay("right") && zoneShown("right")));
  function centerDown(e: PointerEvent) {
    if (floating && !(e.target as HTMLElement).closest("[data-zone=left], [data-zone=right]")) closeOverlays();
  }

  // Docking search results shows the search view.
  $effect(() => {
    if (find.showDocked) {
      find.showDocked = false;
      showView("search");
    }
  });
</script>

<!-- Capture phase: app shortcuts win over focused widgets except the editor, which handles its own first. -->
<svelte:window onkeydown={handleGlobalKey} />

<div class="shell">
  <TopBar />
  <div class="main" class:floating onpointerdowncapture={centerDown}>
    <DockZone zone="left" />
    <div class="center" class:full={isOverlay("left") && isOverlay("right")}>
      <section class="workspace glass">
        <TabBar />
        <EditorPane />
      </section>
      <DockZone zone="bottom" />
    </div>
    <DockZone zone="right" />
  </div>
</div>
<DockOverlay />

{#if ui.help}
  <HelpPanel />
{/if}
{#if settings.open}
  <SettingsPanel />
{/if}
{#if diffState.file}
  {#key diffState.file}<DiffView />{/key}
{/if}
{#if find.open}
  <FindInFiles />
{/if}
{#if palette.open}
  <CommandPalette />
{/if}
<NewProjectDialog />
{#if report.open}
  <ReportDialog />
{/if}
<Dialog />
<ContextMenu />
{#if collab.open}
  <CollabPanel />
{/if}
<Toasts />
<ToolProgress />
<Tooltip />

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 0 var(--gap) var(--gap);
  }
  .main {
    position: relative;
    flex: 1;
    display: flex;
    gap: var(--gap);
    min-height: 0;
  }
  .center {
    flex: 1;
    /* Side panels (sidebar, PDF, debugger) give way before the editor column disappears. */
    min-width: 340px;
    display: flex;
    flex-direction: column;
    gap: var(--gap);
  }
  /* Side zones float over the editor (narrow window): the editor column takes everything. */
  .center.full { min-width: 0; }
  .workspace {
    flex: 1;
    min-height: 120px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
