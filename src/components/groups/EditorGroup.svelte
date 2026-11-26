<script lang="ts">
  import TabBar from "../TabBar.svelte";
  import EditorPane from "../EditorPane.svelte";
  import { app, focusGroup, groupCount } from "../../lib/state.svelte";

  /** One editor group (#219): its own tab bar and editor. A click or focus into it makes it the focused one. */
  let { gid }: { gid: string } = $props();
  const focused = $derived(groupCount() > 1 && app.groups.focused === gid);
</script>

<section class="workspace glass" class:focused data-group={gid} onpointerdowncapture={() => focusGroup(gid)} onfocusincapture={() => focusGroup(gid)}>
  <TabBar {gid} />
  <EditorPane {gid} />
</section>

<style>
  .workspace {
    flex: 1;
    min-height: 120px;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* The group the mode switcher and commands act on. Colour only (no transform/opacity over glass). */
  .workspace.focused { box-shadow: inset 0 0 0 1.5px var(--accent-soft); }
</style>
