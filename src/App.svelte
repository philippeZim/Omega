<script lang="ts">
  import "./lib/collab/assets.svelte";
  import "./lib/collab/latexRemote.svelte";
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
  import "./lib/collab/projectSearch.svelte";
  import "./lib/collab/session.svelte";
  import "./lib/collab/lspHost.svelte";
  import "./lib/collab/lspGuest.svelte";
  import { guestShells } from "./lib/collab/guestShell.svelte";
  import GuestShellBar from "./components/GuestShellBar.svelte";
  import "./lib/collab/debugRemote.svelte";
  import "./lib/collab/gitRemote.svelte";
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
  import { handleGlobalKey, handleZenEscape, palette } from "./lib/commands.svelte";
  import { zen } from "./lib/zen.svelte";
  import { app } from "./lib/state.svelte";
  import { ui } from "./lib/ui.svelte";
  import { t } from "./lib/i18n/index.svelte";

  setConditionHook((current) => ui.prompt(t("app.breakpointCondition"), current, t("app.breakpointConditionPlaceholder")));

  import { onMount } from "svelte";
  import { bootWindow } from "./lib/windowSession.svelte";

  onMount(() => void bootWindow());


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
<svelte:window onkeydown={handleGlobalKey} onkeydowncapture={handleZenEscape} />

<div class="shell" class:zen={zen.on}>
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
{#if guestShells.list.length}
  <GuestShellBar />
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
  /* Zen mode only hides things with CSS: terminals, debugger and PDF stay mounted and keep running.
     No transition on purpose (never animate transform/opacity on or over glass). */
  .shell.zen { padding: 0; }
  .shell.zen > :global(.topbar),
  .shell.zen :global(.dock),
  .shell.zen .workspace > :global(:not(.pane)),
  .shell.zen :global(.cm-gutters) { display: none; }
  .shell.zen .center { min-width: 0; }
  .shell.zen .workspace { border-radius: 0; box-shadow: none; }
  .shell.zen :global(.cm-editor .cm-content) { max-width: var(--prose-width, 1000px); margin: 0 auto; padding: 48px 32px 40vh; }
</style>
