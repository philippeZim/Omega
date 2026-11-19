<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { invoke } from "@tauri-apps/api/core";
  import { runner, createProject } from "../lib/code/runner.svelte";
  import { TEMPLATES } from "../lib/code/projects";
  import { app } from "../lib/state.svelte";
  import { fsApi, dirname, joinPath } from "../lib/api";
  import { cloneInto, cloneTabRequested } from "../lib/git/git.svelte";
  import { t } from "../lib/i18n/index.svelte";

  let tab = $state<"new" | "clone">("new");
  let template = $state(TEMPLATES[0].id);
  let name = $state(t("code.np.defaultName"));
  let parent = $state("");

  // Clone ("Get from VCS")
  let url = $state("");
  let dirName = $state("");
  let dirTouched = false;
  let cloning = $state(false);
  let cloneError = $state("");
  let repos = $state<{ nameWithOwner: string; url: string; description: string; isPrivate: boolean }[] | null>(null);
  let repoFilter = $state("");

  $effect(() => {
    if (runner.newProject && cloneTabRequested.value) {
      cloneTabRequested.value = false;
      tab = "clone";
    }
  });

  $effect(() => {
    if (runner.newProject && !parent) {
      if (app.root) parent = dirname(app.root);
      else fsApi.homeDir().then((h) => (parent = h));
    }
  });

  // Suggest the folder name from the URL (…/repo.git → repo).
  $effect(() => {
    const n = url.trim().replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "") ?? "";
    if (!dirTouched) dirName = n;
  });

  // The user's GitHub repositories via the logged-in gh CLI (silently skipped if unavailable).
  $effect(() => {
    if (tab !== "clone" || repos !== null) return;
    repos = [];
    invoke<{ code: number; stdout: string }>("run_capture", { cmd: "gh", args: ["repo", "list", "--limit", "100", "--json", "nameWithOwner,url,description,isPrivate"], cwd: null })
      .then((r) => (repos = r.code === 0 ? JSON.parse(r.stdout) : []))
      .catch(() => (repos = []));
  });

  const filteredRepos = $derived((repos ?? []).filter((r) => !repoFilter || r.nameWithOwner.toLowerCase().includes(repoFilter.toLowerCase())));
  const validNew = $derived(/^[A-Za-z_][\w-]*$/.test(name) && !!parent);
  const validClone = $derived(!!url.trim() && !!dirName.trim() && !!parent && !cloning);

  async function choose() {
    const d = await openDialog({ directory: true, defaultPath: parent || undefined });
    if (typeof d === "string") parent = d;
  }

  async function submit() {
    if (tab === "new") {
      if (validNew) createProject(template, parent, name);
      return;
    }
    if (!validClone) return;
    const dest = joinPath(parent, dirName.trim());
    if (await fsApi.exists(dest)) {
      cloneError = t("code.existsAlready", { name: dirName }) + ".";
      return;
    }
    cloning = true;
    cloneError = "";
    const err = await cloneInto(url.trim(), dest);
    cloning = false;
    if (err) cloneError = err;
    else {
      runner.newProject = false;
      url = "";
    }
  }

  function close() {
    if (!cloning) runner.newProject = false;
  }
</script>

{#if runner.newProject}
  <div class="backdrop" role="presentation" onclick={close}>
    <div class="sheet" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === "Escape") close(); if (e.key === "Enter" && !(e.target as HTMLElement).closest(".repos")) submit(); }}>
      <div class="seg">
        <button class:on={tab === "new"} onclick={() => (tab = "new")}>{t("code.np.newProject")}</button>
        <button class:on={tab === "clone"} onclick={() => (tab = "clone")}>{t("code.np.cloneFromGit")}</button>
      </div>

      {#if tab === "new"}
        <div class="grid">
          {#each TEMPLATES as tpl (tpl.id)}
            <button class="tpl" class:on={template === tpl.id} onclick={() => (template = tpl.id)}>
              <span class="name">{tpl.label}</span>
              <span class="tool">{tpl.tool}</span>
            </button>
          {/each}
        </div>
        <label>
          <span>{t("code.np.name")}</span>
          <input bind:value={name} spellcheck="false" />
        </label>
      {:else}
        <label>
          <span>{t("code.np.repoUrl")}</span>
          <input bind:value={url} spellcheck="false" placeholder={t("code.np.urlPlaceholder")} />
        </label>
        {#if repos === null || repos.length}
          <div class="repos-head">
            <span>{t("code.np.yourRepos")}</span>
            <input class="filter" bind:value={repoFilter} placeholder={t("common.filter")} spellcheck="false" />
          </div>
          <div class="repos">
            {#if repos === null}
              <p class="muted">{t("common.loading")}</p>
            {:else}
              {#each filteredRepos as r (r.url)}
                <button class="repo" class:on={url === r.url + ".git" || url === r.url} onclick={() => (url = r.url + ".git")} ondblclick={() => { url = r.url + ".git"; submit(); }}>
                  <span class="rname">{r.nameWithOwner}</span>
                  {#if r.isPrivate}<span class="priv">{t("code.np.private")}</span>{/if}
                  <span class="rdesc">{r.description ?? ""}</span>
                </button>
              {:else}
                <p class="muted">{t("common.noResults")}</p>
              {/each}
            {/if}
          </div>
        {/if}
        <label>
          <span>{t("code.np.folderName")}</span>
          <input bind:value={dirName} oninput={() => (dirTouched = true)} spellcheck="false" />
        </label>
      {/if}

      <label>
        <span>{t("code.np.location")}</span>
        <div class="row">
          <input value={parent} readonly />
          <button class="btn" onclick={choose}>{t("common.choose")}</button>
        </div>
      </label>

      {#if tab === "new"}
        <p class="hint">{t("code.np.willCreate")} <code>{parent}/{name}</code>{template === "empty" ? "." : t("code.np.outputInTerminal")}</p>
      {:else}
        <p class="hint" class:err={!!cloneError}>{cloneError || (cloning ? t("code.np.cloning") : t("code.np.cloneInto", { path: `${parent}/${dirName || "…"}` }))}</p>
      {/if}

      <div class="buttons">
        <button class="btn" onclick={close} disabled={cloning}>{t("common.cancel")}</button>
        {#if tab === "new"}
          <button class="btn primary" disabled={!validNew} onclick={submit}>{t("code.np.create")}</button>
        {:else}
          <button class="btn primary" disabled={!validClone} onclick={submit}>{cloning ? t("code.np.cloningBtn") : t("code.np.clone")}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: var(--scrim); }
  .sheet {
    width: 560px;
    padding: 22px 24px 24px;
    border-radius: 28px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: var(--glass-highlight), 0 30px 80px rgba(0, 0, 0, 0.7);
    outline: none;
  }
  .seg { display: grid; grid-template-columns: 1fr 1fr; padding: 3px; margin-bottom: 18px; border-radius: 999px; background: var(--recess); box-shadow: var(--recess-shadow); }
  .seg button { height: 32px; border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--label-2); transition: background 0.2s, color 0.2s; }
  .seg button.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  /* Recessed tray like the segmented control; the selection is a raised glass pill. */
  .grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px;
    padding: 3px; margin-bottom: 18px; border-radius: 18px;
    background: var(--recess); box-shadow: var(--recess-shadow);
  }
  .tpl {
    display: flex; flex-direction: column; gap: 1px;
    padding: 8px 12px; border-radius: 15px; text-align: left;
    transition: background 0.2s, box-shadow 0.2s;
  }
  .tpl:hover:not(.on) { background: rgba(var(--fg-rgb), 0.05); }
  .tpl.on { background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  .tpl .name { font-size: 13px; font-weight: 600; color: var(--label-2); transition: color 0.2s; }
  .tpl .tool { font-size: 11px; color: var(--label-3); }
  .tpl.on .name { color: var(--label); }
  .tpl.on .tool { color: var(--label-2); }
  label { display: block; margin-bottom: 12px; }
  label > span, .repos-head > span { display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--label-2); margin: 0 0 6px 4px; }
  label input { width: 100%; }
  .row { display: flex; gap: 8px; }
  .repos-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .repos-head > span { margin: 0 0 0 4px; }
  .filter { width: 160px; padding: 4px 12px; font-size: 12px; }
  .repos { max-height: 200px; overflow: auto; margin: 8px 0 14px; padding: 4px; border-radius: 16px; background: var(--well); }
  .repo { width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border-radius: 10px; text-align: left; font-size: 12.5px; }
  .repo:hover { background: rgba(var(--fg-rgb), 0.06); }
  .repo.on { background: rgba(var(--fg-rgb), 0.13); }
  .rname { font-weight: 600; white-space: nowrap; }
  .priv { font-size: 10px; padding: 0 6px; border-radius: 999px; background: rgba(var(--fg-rgb), 0.1); color: var(--label-2); }
  .rdesc { color: var(--label-3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted { color: var(--label-3); font-size: 12px; margin: 6px 8px; }
  .hint { font-size: 12px; color: var(--label-3); margin: 4px 4px 18px; }
  .hint.err { color: var(--red); }
  .hint code { font-family: var(--mono); color: var(--label-2); }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .btn:disabled { opacity: 0.4; }
</style>
