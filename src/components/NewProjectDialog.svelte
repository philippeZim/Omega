<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { invoke } from "@tauri-apps/api/core";
  import { runner, createProject } from "../lib/code/runner.svelte";
  import { TEMPLATES } from "../lib/code/projects";
  import { app } from "../lib/state.svelte";
  import { fsApi, dirname, joinPath } from "../lib/api";
  import { cloneInto, cloneTabRequested } from "../lib/git/git.svelte";

  let tab = $state<"new" | "clone">("new");
  let template = $state(TEMPLATES[0].id);
  let name = $state("mein_projekt");
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
      cloneError = `„${dirName}“ existiert dort bereits.`;
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
        <button class:on={tab === "new"} onclick={() => (tab = "new")}>Neues Projekt</button>
        <button class:on={tab === "clone"} onclick={() => (tab = "clone")}>Aus Git klonen</button>
      </div>

      {#if tab === "new"}
        <div class="grid">
          {#each TEMPLATES as t (t.id)}
            <button class="tpl" class:on={template === t.id} onclick={() => (template = t.id)}>
              <span class="name">{t.label}</span>
              <span class="tool">{t.tool}</span>
            </button>
          {/each}
        </div>
        <label>
          <span>Name</span>
          <input bind:value={name} spellcheck="false" />
        </label>
      {:else}
        <label>
          <span>Repository-URL</span>
          <input bind:value={url} spellcheck="false" placeholder="https://github.com/user/repo.git  oder  git@gitlab.com:user/repo.git" />
        </label>
        {#if repos === null || repos.length}
          <div class="repos-head">
            <span>Deine GitHub-Repositories</span>
            <input class="filter" bind:value={repoFilter} placeholder="Filtern" spellcheck="false" />
          </div>
          <div class="repos">
            {#if repos === null}
              <p class="muted">Lade …</p>
            {:else}
              {#each filteredRepos as r (r.url)}
                <button class="repo" class:on={url === r.url + ".git" || url === r.url} onclick={() => (url = r.url + ".git")} ondblclick={() => { url = r.url + ".git"; submit(); }}>
                  <span class="rname">{r.nameWithOwner}</span>
                  {#if r.isPrivate}<span class="priv">privat</span>{/if}
                  <span class="rdesc">{r.description ?? ""}</span>
                </button>
              {:else}
                <p class="muted">Keine Treffer</p>
              {/each}
            {/if}
          </div>
        {/if}
        <label>
          <span>Ordnername</span>
          <input bind:value={dirName} oninput={() => (dirTouched = true)} spellcheck="false" />
        </label>
      {/if}

      <label>
        <span>Ort</span>
        <div class="row">
          <input value={parent} readonly />
          <button class="btn" onclick={choose}>Wählen…</button>
        </div>
      </label>

      {#if tab === "new"}
        <p class="hint">Wird erstellt in <code>{parent}/{name}</code> – die Ausgabe erscheint im Terminal.</p>
      {:else}
        <p class="hint" class:err={!!cloneError}>{cloneError || (cloning ? "Klone … (das kann bei großen Repositories dauern)" : `Wird geklont nach ${parent}/${dirName || "…"}`)}</p>
      {/if}

      <div class="buttons">
        <button class="btn" onclick={close} disabled={cloning}>Abbrechen</button>
        {#if tab === "new"}
          <button class="btn primary" disabled={!validNew} onclick={submit}>Erstellen</button>
        {:else}
          <button class="btn primary" disabled={!validClone} onclick={submit}>{cloning ? "Klone …" : "Klonen"}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: rgba(0, 0, 0, 0.55); }
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
  .seg button.on { color: #fff; background: rgba(255, 255, 255, 0.15); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14); }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 18px; }
  .tpl { display: flex; flex-direction: column; gap: 3px; padding: 12px 10px; border-radius: 16px; background: rgba(255, 255, 255, 0.05); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04); text-align: left; }
  .tpl:hover { background: rgba(255, 255, 255, 0.09); }
  .tpl.on { background: var(--accent); }
  .tpl .name { font-weight: 600; }
  .tpl .tool { font-size: 11px; color: var(--label-2); }
  .tpl.on .tool { color: rgba(255, 255, 255, 0.8); }
  label { display: block; margin-bottom: 12px; }
  label > span, .repos-head > span { display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--label-2); margin: 0 0 6px 4px; }
  label input { width: 100%; }
  .row { display: flex; gap: 8px; }
  .repos-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .repos-head > span { margin: 0 0 0 4px; }
  .filter { width: 160px; padding: 4px 12px; font-size: 12px; }
  .repos { max-height: 200px; overflow: auto; margin: 8px 0 14px; padding: 4px; border-radius: 16px; background: rgba(0, 0, 0, 0.2); }
  .repo { width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border-radius: 10px; text-align: left; font-size: 12.5px; }
  .repo:hover { background: rgba(255, 255, 255, 0.06); }
  .repo.on { background: rgba(255, 255, 255, 0.13); }
  .rname { font-weight: 600; white-space: nowrap; }
  .priv { font-size: 10px; padding: 0 6px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); color: var(--label-2); }
  .rdesc { color: var(--label-3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted { color: var(--label-3); font-size: 12px; margin: 6px 8px; }
  .hint { font-size: 12px; color: var(--label-3); margin: 4px 4px 18px; }
  .hint.err { color: var(--red); }
  .hint code { font-family: var(--mono); color: var(--label-2); }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .btn:disabled { opacity: 0.4; }
</style>
