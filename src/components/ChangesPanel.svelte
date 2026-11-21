<script lang="ts">
  import { git, kind, commit, push, pull, rollback, absPath, initRepo, cloneRepo, publishGitHub, connectRemote, isGuestGit, guestRefusal, type Change } from "../lib/git/git.svelte";
  import { guestChanges, guestStage, isStaged } from "../lib/collab/gitRemote.svelte";
  import { openDiff } from "../lib/git/diff.svelte";
  import { openFile, app } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import { basename } from "../lib/api";
  import { formatKey } from "../lib/keys";
  import { keysFor } from "../lib/commands.svelte";
  import { t } from "../lib/i18n/index.svelte";

  let textarea: HTMLTextAreaElement | undefined = $state();
  export function focusMessage() {
    textarea?.focus();
  }

  const LABEL = { new: "git.status.new", modified: "git.status.modified", deleted: "git.status.deleted", renamed: "git.status.renamed", conflict: "git.status.conflict" } as const;
  const allOn = $derived(git.changes.length > 0 && git.excluded.length === 0);
  const selectedCount = $derived(git.changes.length - git.excluded.length);

  function toggle(c: Change) {
    const i = git.excluded.indexOf(c.path);
    if (i >= 0) git.excluded.splice(i, 1);
    else git.excluded.push(c.path);
  }

  function toggleAll() {
    git.excluded = allOn ? git.changes.map((c) => c.path) : [];
  }

  /** Menu entries a guest would be refused: disabled, with the reason as tooltip. */
  const refused = (a: Parameters<typeof guestRefusal>[0], c?: Change) => {
    const why = guestRefusal(a, c);
    return why ? { disabled: true, title: why } : {};
  };

  function menu(e: MouseEvent, c: Change) {
    ui.openMenu(e, [
      { label: t("git.showDiff"), action: () => openDiff(absPath(c.path)) },
      ...(kind(c) !== "deleted" ? [{ label: t("git.openFile"), action: () => openFile(absPath(c.path)) }] : []),
      ...(isGuestGit() ? [{ label: isStaged(c) ? t("git.unstage") : t("git.stage"), action: () => guestStage(c, !isStaged(c)), ...refused("stage") }] : []),
      { separator: true, label: "" },
      { label: kind(c) === "new" ? t("git.deleteEllipsis") : t("git.discardChangesEllipsis"), danger: true, action: () => rollback(c), ...refused("discard", c) },
    ]);
  }

  /** Auto-height: grows with the text up to a limit (no manual resize handle). */
  function grow() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(220, textarea.scrollHeight) + "px";
  }
  $effect(() => {
    void git.message;
    queueMicrotask(grow);
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const andPush = e.shiftKey || e.altKey;
      if (!andPush) return commit(false);
      // Shift/Alt held by accident must not publish the commit.
      ui.confirm(t("git.confirmPushTitle", { ref: git.upstream ?? "origin/" + git.branch }), t("git.confirmPushBody"), "Commit & Push")
        .then((ok) => { if (ok) commit(true); });
    }
  }
</script>

<div class="changes">
  {#if isGuestGit() && !git.repo}
    <p class="hint">{t("git.guestNoGit")}</p>
  {:else if !app.root && !isGuestGit()}
    <p class="hint">{t("git.openFolderHint")}</p>
  {:else if !git.repo}
    <div class="empty">
      <p>{t("git.notRepo")}</p>
      <button class="btn primary" onclick={initRepo}>{t("git.createRepo")}</button>
      <button class="btn" onclick={publishGitHub}>{t("git.publishGitHubEllipsis")}</button>
      <button class="btn" onclick={cloneRepo}>{t("git.cloneRepoEllipsis")}</button>
    </div>
  {:else}
    <div class="branchbar">
      <span class="branch" title={git.upstream ? t("git.tracks", { upstream: git.upstream }) : t("git.noUpstream")}>
        <svg width="12" height="12" viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="4" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 5.3v5.4M12 6.8c0 3-4 2.5-7.2 4.4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
        {git.branch || "—"}
      </span>
      <span class="spacer"></span>
      <button class="sync" title={guestRefusal("pull") || t("git.pullTitle", { key: formatKey(keysFor("git.pull")[0] ?? "") })} onclick={pull} disabled={!!git.busy || !!guestRefusal("pull")}>
        ↓{#if git.behind}<b>{git.behind}</b>{/if}
      </button>
      <button class="sync" title={guestRefusal("push") || `Push (${formatKey(keysFor("git.push")[0] ?? "")})`} onclick={push} disabled={!!git.busy || !!guestRefusal("push")}>
        ↑{#if git.ahead}<b>{git.ahead}</b>{/if}
      </button>
    </div>

    {#if !git.remoteUrl && !isGuestGit()}
      <div class="noremote">
        <span>{t("git.noRemote")}</span>
        <div class="nr-buttons">
          <button class="btn small" onclick={connectRemote}>{t("git.connectRemoteEllipsis")}</button>
          <button class="btn small" onclick={publishGitHub}>{t("git.publishGitHubEllipsis")}</button>
        </div>
      </div>
    {/if}

    <div class="listhead">
      <button class="check" class:on={allOn} class:partial={!allOn && selectedCount > 0} onclick={toggleAll} aria-label={t("git.selectAll")}></button>
      <span>{git.changes.length ? t(git.changes.length === 1 ? "git.changesOne" : "git.changesMany", { n: git.changes.length }) : t("git.noChanges")}</span>
    </div>

    <div class="list">
      {#each git.changes as c (c.path)}
        {@const k = kind(c)}
        <div class="row" role="button" tabindex="-1" ondblclick={() => openDiff(absPath(c.path))} oncontextmenu={(e) => menu(e, c)} onkeydown={() => {}} title={t("git.rowTitle", { status: t(LABEL[k]), path: c.orig ? `${c.orig} → ${c.path}` : c.path })}>
          <button class="check" class:on={!git.excluded.includes(c.path)} onclick={() => toggle(c)} aria-label={t("git.select")}></button>
          <span class="name {k}">{basename(c.path)}</span>
          <span class="dir">{c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : ""}</span>
          {#if isGuestGit() && isStaged(c)}<span class="staged" title={t("git.staged")}>S</span>{/if}
          <span class="badge {k}">{k === "new" ? "N" : k === "modified" ? "M" : k === "deleted" ? "D" : k === "renamed" ? "R" : "!"}</span>
          <button class="undo" disabled={!!guestRefusal("discard", c)} title={guestRefusal("discard", c) || (k === "new" ? t("common.delete") : t("git.discard"))} onclick={(e) => { e.stopPropagation(); rollback(c); }} aria-label={t("git.revert")}>↺</button>
        </div>
      {/each}
    </div>

    {#if isGuestGit() && guestChanges.truncated}<p class="note">{t("git.changesTruncated", { n: git.changes.length })}</p>{/if}

    <div class="commit">
      {#if isGuestGit()}<p class="note">{t("git.guestCommitNote")}</p>{/if}
      <textarea bind:this={textarea} bind:value={git.message} onkeydown={onKey} oninput={grow} rows="2" placeholder={t("git.commitMessage")} spellcheck="true"></textarea>
      <div class="buttons">
        <button class="btn primary" onclick={() => commit(false)} disabled={!!git.busy || !selectedCount || !!guestRefusal("commit")} title={guestRefusal("commit") || formatKey("Mod-Enter")}>Commit</button>
        <button class="btn" onclick={() => commit(true)} disabled={!!git.busy || !selectedCount || !!guestRefusal("commitPush")} title={guestRefusal("commitPush") || formatKey("Mod-Shift-Enter")}>Commit & Push</button>
      </div>
      {#if git.busy}<p class="busy">{git.busy}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .changes { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 8px 10px 10px; }
  .hint { color: var(--label-3); padding: 8px; font-size: 12.5px; }
  .empty { display: flex; flex-direction: column; gap: 8px; padding: 18px 8px; color: var(--label-2); font-size: 12.5px; }
  .empty p { margin: 0 0 6px; }
  .branchbar { display: flex; align-items: center; gap: 4px; padding: 2px 4px 8px; }
  .branch { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .branch svg { color: var(--label-3); flex-shrink: 0; }
  .spacer { flex: 1; }
  .sync { height: 26px; min-width: 30px; padding: 0 8px; border-radius: 999px; font-size: 13px; color: var(--label-2); background: rgba(var(--fg-rgb), 0.05); }
  .sync:hover:not(:disabled) { background: rgba(var(--fg-rgb), 0.12); color: var(--label); }
  .sync b { margin-left: 3px; font-size: 11px; color: var(--accent); }
  .sync:disabled { opacity: 0.5; }
  .noremote { margin: 0 2px 8px; padding: 10px 12px; border-radius: 14px; background: rgba(214, 163, 95, 0.08); box-shadow: inset 0 0 0 1px rgba(214, 163, 95, 0.18); font-size: 12px; color: var(--label-2); }
  .nr-buttons { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .btn.small { padding: 6px 12px; font-size: 12px; }
  .listhead { display: flex; align-items: center; gap: 8px; padding: 6px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--label-2); }
  .listhead span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list { flex: 1; min-height: 60px; overflow-x: hidden; overflow-y: auto; }
  .row { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 6px; border-radius: 9px; font-size: 12.5px; }
  .row:hover { background: var(--fill-hover); }
  .check { width: 15px; height: 15px; flex-shrink: 0; border-radius: 5px; border: 1.4px solid var(--label-3); position: relative; transition: background 0.15s, border-color 0.15s; }
  .check.on, .check.partial { background: var(--accent); border-color: var(--accent); }
  .check.on::after { content: ""; position: absolute; left: 4px; top: 1px; width: 3.5px; height: 7px; border: solid #fff; border-width: 0 1.8px 1.8px 0; transform: rotate(45deg); }
  .check.partial::after { content: ""; position: absolute; left: 3px; right: 3px; top: 5.5px; height: 1.6px; background: #fff; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name.new { color: var(--green); }
  .name.modified { color: var(--accent); }
  .name.deleted { color: var(--label-3); text-decoration: line-through; }
  .name.conflict { color: var(--red); }
  .dir { flex: 1; min-width: 0; color: var(--label-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { margin: 0 2px 6px; font-size: 11.5px; color: var(--label-3); }
  .staged { flex-shrink: 0; font-family: var(--mono); font-size: 10.5px; font-weight: 700; color: var(--green); }
  .badge { flex-shrink: 0; font-family: var(--mono); font-size: 10.5px; font-weight: 700; color: var(--label-3); }
  .badge.new { color: var(--green); }
  .badge.modified { color: var(--accent); }
  .badge.conflict { color: var(--red); }
  .undo { flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; color: var(--label-3); opacity: 0; }
  .row:hover .undo { opacity: 1; }
  .undo:disabled { color: var(--label-3); background: none; cursor: default; }
  .undo:hover:not(:disabled) { background: var(--fill-2); color: var(--label); }
  .commit { padding-top: 8px; border-top: 1px solid rgba(var(--fg-rgb), 0.06); }
  textarea {
    display: block;
    width: 100%;
    min-height: 58px;
    resize: none;
    overflow-x: hidden;
    overflow-y: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 10px 14px;
    border: none;
    border-radius: 14px;
    outline: none;
    font: inherit;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--label);
    background: var(--recess);
    box-shadow: var(--recess-shadow);
    user-select: text;
    scrollbar-width: thin;
    transition: box-shadow 0.15s;
  }
  textarea::placeholder { color: var(--label-3); }
  textarea::-webkit-scrollbar { width: 8px; height: 0; }
  textarea::-webkit-scrollbar-thumb { background: rgba(var(--fg-rgb), 0.12); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
  textarea::-webkit-resizer { display: none; }
  textarea:focus { box-shadow: var(--recess-shadow), 0 0 0 1px rgba(var(--fg-rgb), 0.14); }
  .buttons { display: flex; gap: 6px; margin-top: 8px; }
  .buttons .btn { flex: 1; min-width: 0; padding: 8px 10px; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .buttons .btn:last-child { flex: 1.35; }
  .btn:disabled { opacity: 0.4; }
  .busy { margin: 6px 2px 0; font-size: 11.5px; color: var(--label-3); }
</style>
