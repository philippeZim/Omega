<script lang="ts">
  import { app, setMode, openFolder, setRoot, recentFolders } from "../lib/state.svelte";
  import { fsApi } from "../lib/api";
  import { t } from "../lib/i18n/index.svelte";
  import { git, branches, switchBranch, newBranch, pull, push, cloneRepo, publishGitHub, initRepo, connectRemote } from "../lib/git/git.svelte";

  async function branchMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const b = await branches();
    const ctrl = t("app.ctrl");
    ui.openMenu(new MouseEvent("contextmenu", { clientX: r.left, clientY: r.bottom + 8 }), [
      { label: t("app.newBranch"), action: newBranch },
      { label: t("app.pull") + (git.behind ? t("app.behind", { n: git.behind }) : ""), shortcut: `${ctrl} T`, action: pull },
      { label: "Push" + (git.ahead ? t("app.ahead", { n: git.ahead }) : ""), shortcut: `${ctrl} ⇧ K`, action: push },
      { label: t("app.showChanges"), shortcut: `${ctrl} K`, action: () => { app.sidebar = true; app.sidebarView = "changes"; } },
      { label: git.remoteUrl ? t("app.remoteChange", { url: git.remoteUrl.replace(/^https?:\/\/|^git@/, "").replace(/\.git$/, "") }) : t("app.connectRemote"), action: connectRemote },
      { separator: true, label: "" },
      ...b.local.map((n) => ({ label: (n === git.branch ? "✓  " : "     ") + n, action: () => n !== git.branch && switchBranch(n) })),
      ...(b.remote.length ? [{ separator: true, label: "" }, ...b.remote.map((n) => ({ label: "     " + n, action: () => switchBranch(n, true) }))] : []),
    ]);
  }

  function projectMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const home = localStorage.getItem("homeDir") ?? "";
    const pretty = (p: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);
    const recents = recentFolders.filter((f) => f !== app.root).slice(0, 8);
    ui.openMenu(new MouseEvent("contextmenu", { clientX: r.left, clientY: r.bottom + 8 }), [
      { label: t("app.openFolder") + "…", shortcut: `${t("app.ctrl")} O`, action: openFolder },
      { label: t("app.newProject") + "…", action: () => (runner.newProject = true) },
      { label: t("app.cloneRepo"), action: cloneRepo },
      ...(app.root && !git.repo ? [{ label: t("app.initRepo"), action: initRepo }] : []),
      ...(app.root ? [{ label: t("app.publishGitHub"), action: publishGitHub }] : []),
      ...(recents.length ? [{ separator: true, label: "" }, ...recents.map((f) => ({ label: pretty(f), action: async () => ((await fsApi.exists(f)) ? setRoot(f) : ui.toast(t("app.folderGone"), "error")) }))] : []),
      ...(app.root ? [{ separator: true, label: "" }, { label: t("app.closeFolder"), action: () => setRoot(null) }] : []),
    ]);
  }
  fsApi.homeDir().then((h) => localStorage.setItem("homeDir", h));
  import { ui } from "../lib/ui.svelte";
  import { MODES } from "../lib/modes";
  import { basename } from "../lib/api";
  import { runner } from "../lib/code/runner.svelte";
  import { settings } from "../lib/settings.svelte";
  import { collab } from "../lib/collab/collab.svelte";
  import { share } from "../lib/collab/share.svelte";

  const activeIndex = $derived(MODES.findIndex((m) => m.id === app.mode));
</script>

<header class="topbar">
  <div class="left">
    <button class="ghost" title="{t('app.sidebar')} ({t('app.ctrl')}+B)" onclick={() => (app.sidebar = !app.sidebar)} aria-label={t("app.sidebar")}>
      <svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" stroke-width="1.3"/></svg>
    </button>
    <button class="title" onclick={projectMenu} title={app.root ?? t("app.openFolder")}>
      {collab.role === "guest" && collab.status === "connected" ? t("app.hostSuffix", { name: share.hostRoot || t("app.project") }) : app.root ? basename(app.root) : t("app.noFolder")}
      <svg width="9" height="9" viewBox="0 0 10 10"><path d="M2.5 3.8L5 6.3l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    {#if git.repo && git.branch}
      <button class="branch" onclick={branchMenu} title={t("app.branchTitle")}>
        <svg width="12" height="12" viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="4" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 5.3v5.4M12 6.8c0 3-4 2.5-7.2 4.4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
        <span>{git.branch}</span>
        {#if git.ahead}<span class="ab">↑{git.ahead}</span>{/if}
        {#if git.behind}<span class="ab">↓{git.behind}</span>{/if}
        {#if git.changes.length}<span class="dirty"></span>{/if}
      </button>
    {/if}
    <span class="divider"></span>
    <button class="ghost" title="{t('app.openFolder')} ({t('app.ctrl')}+O)" onclick={openFolder} aria-label={t("app.openFolder")}>
      <svg width="15" height="14" viewBox="0 0 15 14"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.3 1.5h5.7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
    </button>
    <button class="ghost" title={t("app.newProject")} onclick={() => (runner.newProject = true)} aria-label={t("app.newProject")}>
      <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
  </div>

  <div class="segmented" role="tablist" style="--count: {MODES.length}">
    <div class="thumb" style="--index: {activeIndex}"></div>
    {#each MODES as m, i (m.id)}
      <button role="tab" aria-selected={app.mode === m.id} class:active={app.mode === m.id} title="{m.label} ({t('app.ctrl')}+{i + 1})" onclick={() => setMode(m.id)}>
        {m.label}
      </button>
    {/each}
  </div>

  <div class="right">
    <button class="ghost help collab" class:on={collab.open} class:live={!!collab.role} title={t("app.collab")} onclick={() => (collab.open = !collab.open)} aria-label={t("app.collab")}>
      {#if collab.role && collab.participants.length > 1}
        <span class="faces">
          {#each collab.participants.slice(0, 3) as p (p.peer)}<span class="face" style="background: {p.color}">{p.name.slice(0, 1).toUpperCase()}</span>{/each}
        </span>
      {:else}
        <svg width="18" height="16" viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="5" r="2.6"/><path d="M2 14c.6-2.7 2.6-4.2 5-4.2s4.4 1.5 5 4.2"/><circle cx="14.2" cy="5.6" r="2.1"/><path d="M13.4 9.9c2.1-.2 3.9 1.1 4.6 3.6"/></svg>
      {/if}
      {#if collab.requests.length}<span class="badge">{collab.requests.length}</span>{/if}
    </button>
    <button class="ghost help gear" class:on={settings.open} title={t("app.settings")} onclick={() => (settings.open = !settings.open)} aria-label={t("app.settings")}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
    </button>
    <button class="ghost help" class:on={ui.help} title={t("app.cheatSheet")} onclick={() => (ui.help = !ui.help)} aria-label={t("app.help")}>?</button>
  </div>
</header>

<style>
  .topbar {
    height: 58px;
    flex-shrink: 0;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0 4px;
  }
  .left, .right { display: flex; align-items: center; gap: 8px; }
  .left {
    justify-self: start;
    padding: 4px;
    border-radius: 999px;
    background: var(--glass);
    box-shadow: var(--glass-highlight), 0 6px 20px rgba(0, 0, 0, 0.4);
  }
  .right { justify-content: flex-end; gap: 10px; }
  .title { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 999px; font-weight: 600; font-size: 13px; color: var(--label); transition: background 0.15s; }
  .title:hover { background: var(--fill-hover); }
  .title svg { color: var(--label-3); }
  .branch { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 999px; font-size: 12.5px; color: var(--label-2); max-width: 220px; transition: background 0.15s; }
  .branch:hover { background: var(--fill-hover); color: var(--label); }
  .branch span:not(.ab):not(.dirty) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .branch .ab { font-size: 11px; color: var(--accent); }
  .branch .dirty { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .divider { width: 1px; height: 16px; background: rgba(var(--fg-rgb), 0.09); }
  .ghost {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--label-2);
    transition: background 0.12s, color 0.12s;
  }
  .ghost:hover { background: var(--fill-hover); color: var(--label); }
  .help {
    width: 40px;
    height: 40px;
    font-weight: 700;
    font-size: 15px;
    color: var(--label);
    background: var(--glass);
    box-shadow: var(--glass-highlight), 0 6px 20px rgba(0, 0, 0, 0.4);
  }
  .help:hover { background: var(--glass-strong); }
  .help.on { background: rgba(var(--fg-rgb), 0.18); color: var(--label); }
  .collab { position: relative; width: auto; min-width: 40px; padding: 0 9px; border-radius: 999px; gap: 6px; display: flex; align-items: center; justify-content: center; }
  .collab.live::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 2px var(--glass-strong); }
  .faces { display: flex; }
  .face { width: 24px; height: 24px; margin-left: -7px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #111; box-shadow: 0 0 0 2px var(--glass-strong); }
  .face:first-child { margin-left: 0; }
  .badge { position: absolute; top: -3px; right: -3px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--red); color: #fff; font-size: 10px; font-weight: 700; display: grid; place-items: center; }
  .gear svg { transition: transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
  .gear:hover svg { transform: rotate(60deg); }

  .segmented {
    position: relative;
    display: grid;
    grid-template-columns: repeat(var(--count), 1fr);
    padding: 4px;
    border-radius: 999px;
    background: var(--glass);
    box-shadow: var(--glass-highlight), 0 8px 24px rgba(0, 0, 0, 0.45);
    width: calc(var(--count) * 104px);
  }
  .segmented::before {
    content: "";
    position: absolute;
    inset: 4px;
    border-radius: 999px;
    background: var(--recess);
    box-shadow: var(--recess-shadow);
  }
  .thumb {
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: calc((100% - 8px) / var(--count));
    /* Animating `left` instead of `transform`: WebKitGTK flashes a stale frame when an
       accelerated transform transition ends. */
    left: calc(4px + var(--index) * (100% - 8px) / var(--count));
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(var(--fg-rgb), 0.2), rgba(var(--fg-rgb), 0.12));
    box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.18), 0 4px 12px rgba(0, 0, 0, 0.45);
    transition: left 0.3s cubic-bezier(0.3, 0.9, 0.3, 1);
  }
  .segmented button {
    position: relative;
    z-index: 1;
    height: 32px;
    font-size: 13px;
    font-weight: 500;
    color: var(--label-2);
    transition: color 0.2s;
  }
  .segmented button.active { color: var(--label); font-weight: 600; }
</style>
