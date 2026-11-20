<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { MergeView } from "@codemirror/merge";
  import { EditorView, lineNumbers } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { syntaxHighlighting } from "@codemirror/language";
  import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
  import { keymap } from "@codemirror/view";
  import { diffState, DIFF_CONFIG } from "../lib/git/diff.svelte";
  import { git, refresh } from "../lib/git/git.svelte";
  import { app } from "../lib/state.svelte";
  import { fsApi, basename } from "../lib/api";
  import * as ed from "../lib/editor";
  import { detectEol, toDisk, type Eol } from "../lib/eol";
  import { langFor } from "../lib/code/languages";
  import { baseTheme, codeHighlight } from "../lib/theme";
  import { t } from "../lib/i18n/index.svelte";

  let host: HTMLDivElement | undefined = $state();
  let view: MergeView | null = null;
  let writeTimer: number | undefined;
  let eol: Eol = "\n";
  let info = $state<"git.diff.deleted" | "git.diff.newFile" | "git.diff.renamedFrom" | "git.diff.binary" | null>(null);
  let binary = $state(false);
  const file = diffState.file!;
  const rel = git.top && file.startsWith(git.top + "/") ? file.slice(git.top.length + 1) : file;
  // A renamed/copied file has no HEAD version under its new path: compare against the source (#70).
  const orig = git.changes.find((c) => c.path === rel)?.orig ?? null;

  function close() {
    diffState.file = null;
    refresh();
    queueMicrotask(() => ed.focus());
  }

  onMount(async () => {
    const headPath = orig && git.top ? git.top + "/" + orig : file;
    const head = (await invoke<string | null>("git_head_file", { root: git.top || app.root, path: headPath })) ?? "";
    const tab = app.tabs.find((t) => t.path === file);
    let current = "";
    let unreadable = false;
    try {
      current = tab ? ed.getText(tab.id) : await fsApi.readFile(file);
      eol = detectEol(current);
    } catch {
      // Not readable as UTF-8 text is not the same as gone (#66).
      unreadable = await fsApi.exists(file).catch(() => false);
      if (!unreadable) info = "git.diff.deleted";
    }
    if (!head) info = "git.diff.newFile";
    else if (orig) info = "git.diff.renamedFrom";
    // Binary content (NUL bytes, or not UTF-8): a text diff would show lossily decoded bytes, and
    // reverting a chunk would write them back and corrupt the file (#66). No editor, no revert arrows.
    if (unreadable || head.includes("\0") || current.includes("\0")) {
      binary = true;
      info = "git.diff.binary";
      return;
    }
    const lang = langFor(file);
    const common = [lineNumbers(), lang ? lang.ext() : [], syntaxHighlighting(codeHighlight), baseTheme, EditorView.editorAttributes.of({ class: "mode-code" })];
    view = new MergeView({
      parent: host!,
      a: { doc: head, extensions: [...common, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      b: {
        doc: current,
        extensions: [
          ...common,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            // Edits (incl. reverted chunks) go into the open tab or straight to disk.
            const t = app.tabs.find((x) => x.path === file);
            for (const tr of u.transactions) if (t && tr.docChanged) ed.applyChanges(t.id, { changes: tr.changes });
            if (!t) {
              clearTimeout(writeTimer);
              const doc = u.state.doc;
              writeTimer = window.setTimeout(() => fsApi.writeFile(file, toDisk(doc.toString(), eol)), 500);
            }
          }),
        ],
      },
      revertControls: "a-to-b",
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
      // The default character diff gives up on files with many scattered changes (#74).
      diffConfig: DIFF_CONFIG,
    });
  });

  onDestroy(() => {
    if (writeTimer && view && !app.tabs.some((t) => t.path === file)) {
      clearTimeout(writeTimer);
      fsApi.writeFile(file, toDisk(view.b.state.doc.toString(), eol)).catch(() => {});
    }
    view?.destroy();
  });
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && (e.preventDefault(), close())} />

<div class="backdrop" role="presentation" onclick={close}>
  <div class="sheet" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <header>
      <span class="title">{basename(file)}</span>
      <span class="path">{rel}</span>
      {#if info}<span class="info">{info === "git.diff.renamedFrom" ? t(info, { orig: orig ?? "" }) : t(info)}</span>{/if}
      <span class="spacer"></span>
      <button class="close" onclick={close} aria-label={t("common.close")}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </header>
    {#if !binary}<div class="labels"><span>{t("git.diff.head")}</span><span>{t("git.diff.current")}</span></div>{/if}
    {#if binary}
      <div class="binary">{t("git.diff.binaryHint")}</div>
    {:else}
      <div class="merge" bind:this={host}></div>
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 86; display: grid; place-items: center; background: var(--scrim); }
  .sheet { width: 94vw; height: 90vh; display: flex; flex-direction: column; border-radius: 24px; background: var(--glass-strong); backdrop-filter: var(--blur); box-shadow: var(--glass-highlight), 0 30px 90px rgba(0, 0, 0, 0.7); overflow: hidden; outline: none; /* no open animation: WebKitGTK flashes when glass animates */ }
  header { display: flex; align-items: baseline; gap: 12px; padding: 16px 16px 8px 22px; }
  .title { font-weight: 700; font-size: 15px; }
  .path { font-family: var(--mono); font-size: 12px; color: var(--label-3); }
  .info { font-size: 12px; color: var(--orange); }
  .spacer { flex: 1; }
  .close { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; color: var(--label-2); align-self: center; }
  .close:hover { background: var(--fill-hover); color: var(--label); }
  .labels { display: grid; grid-template-columns: 1fr 1fr; padding: 0 22px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--label-3); }
  .binary { flex: 1; display: grid; place-items: center; padding: 24px; text-align: center; font-size: 13px; color: var(--label-3); background: var(--well); }
  .merge { flex: 1; min-height: 0; overflow: auto; background: var(--well); }
  .merge :global(.cm-mergeView) { height: 100%; }
  .merge :global(.cm-mergeViewEditors) { min-height: 100%; }
  .merge :global(.cm-changedLine) { background: rgba(107, 155, 224, 0.1) !important; }
  .merge :global(.cm-deletedChunk), .merge :global(.cm-merge-a .cm-changedLine) { background: rgba(223, 112, 103, 0.12) !important; }
  .merge :global(.cm-merge-b .cm-changedLine) { background: rgba(123, 191, 142, 0.12) !important; }
  .merge :global(.cm-changedText) { background: rgba(var(--fg-rgb), 0.12) !important; }
  .merge :global(.cm-merge-revert button) { color: var(--label-2); background: rgba(var(--fg-rgb), 0.08); border: none; border-radius: 6px; cursor: pointer; }
  .merge :global(.cm-merge-revert) { background: transparent; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes pop { from { opacity: 0; transform: scale(0.98); } }
</style>
