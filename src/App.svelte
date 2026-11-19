<script lang="ts">
  import TopBar from "./components/TopBar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import TabBar from "./components/TabBar.svelte";
  import EditorPane from "./components/EditorPane.svelte";
  import Dialog from "./components/Dialog.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import Toasts from "./components/Toasts.svelte";
  import HelpPanel from "./components/HelpPanel.svelte";
  import SettingsPanel from "./components/SettingsPanel.svelte";
  import { settings } from "./lib/settings.svelte";
  import PdfPanel from "./components/PdfPanel.svelte";
  import TerminalPanel from "./components/TerminalPanel.svelte";
  import NewProjectDialog from "./components/NewProjectDialog.svelte";
  import DebugPanel from "./components/DebugPanel.svelte";
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

  setGitGutterHooks({ root: () => git.top || app.root, menu: (e, items) => ui.openMenu(e, items), showDiff: openDiff });
  startGitWatch();
  window.addEventListener("studio:saved", () => gitRefresh());
  $effect(() => {
    void app.root;
    gitRefresh();
  });
  $effect(() => {
    void git.headVersion;
    reloadGitHeads();
  });
  import { find } from "./lib/search/search.svelte";
  import { dbg } from "./lib/debug/store.svelte";
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

  // `studio <folder|file>…` opens folders as workspace and files as tabs.
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

</script>

<!-- Capture phase: app shortcuts win over focused widgets except the editor, which handles its own first. -->
<svelte:window onkeydown={handleGlobalKey} />

<div class="shell">
  <TopBar />
  <div class="main">
    {#if app.sidebar}
      <Sidebar />
    {/if}
    <div class="center">
      <section class="workspace glass">
        <TabBar />
        <EditorPane />
      </section>
      <!-- Kept mounted in every mode so shell sessions survive mode switches. -->
      <div class="term-slot" class:hidden={app.mode !== "code"}>
        <TerminalPanel />
      </div>
    </div>
    {#if app.mode === "code" && dbg.panel}
      <DebugPanel />
    {/if}
    {#if app.mode === "latex" && app.activeId}
      <PdfPanel />
    {/if}
  </div>
</div>

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
<Dialog />
<ContextMenu />
{#if collab.open}
  <CollabPanel />
{/if}
<Toasts />
<Tooltip />

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 0 var(--gap) var(--gap);
  }
  .main {
    flex: 1;
    display: flex;
    gap: var(--gap);
    min-height: 0;
  }
  .center {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--gap);
  }
  .term-slot { display: contents; }
  .term-slot.hidden { display: none; }
  .workspace {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
