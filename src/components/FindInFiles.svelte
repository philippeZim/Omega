<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { openDialog } from "../lib/native";
  import { EditorState, type Extension } from "@codemirror/state";
  import { EditorView, lineNumbers, highlightActiveLine, keymap, drawSelection } from "@codemirror/view";
  import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
  import { syntaxHighlighting } from "@codemirror/language";
  import { find, runSearch, gotoHit, dockResults, replaceInFile, replaceAll, buildRegex, persistOptions, matchSummary, type Hit } from "../lib/search/search.svelte";
  import { matchHighlighter, refreshMatches } from "../lib/search/previewMatches";
  import { previewWriter } from "../lib/search/previewWriter";
  import { activeRemote } from "../lib/search/remote";
  import { app } from "../lib/state.svelte";
  import { fsApi, basename, normPath } from "../lib/api";
  import * as ed from "../lib/editor";
  import { runViewAction } from "../lib/editorActions";
  import { detectEol, toDisk, type Eol } from "../lib/eol";
  import { langFor, indentFor } from "../lib/code/languages";
  import { baseTheme, codeHighlight } from "../lib/theme";
  import { formatKey } from "../lib/keys";
  import { t } from "../lib/i18n/index.svelte";

  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let previewHost: HTMLDivElement | undefined = $state();
  let preview: EditorView | null = null;
  let previewFile: string | null = null;
  let previewEol: Eol = "\n";
  const writer = previewWriter((f, text) => fsApi.writeFile(f, text).catch(() => {}));

  const hit = $derived(find.hits[find.selected] as Hit | undefined);
  const rel = (f: string) => (f.startsWith("collab:") ? f.slice(7) : app.root && f.startsWith(app.root + "/") ? f.slice(app.root.length + 1) : f);
  /** A guest in a session: the files are the host's, so the preview only shows them. */
  const remote = activeRemote();
  const folderName = (f: string) => (f === "collab:" ? "/" : basename(rel(f)));

  tick().then(() => {
    input?.focus();
    input?.select();
  });

  // ---------------------------------------------------------------- preview editor

  /** Highlights every match of the current query in the preview. */
  const highlighter = matchHighlighter(() => (find.query ? buildRegex() : null));

  /** Guest: lets go of the shared doc behind the preview. */
  let releaseDoc: (() => void) | null = null;
  function detachDoc() {
    releaseDoc?.();
    releaseDoc = null;
  }

  /** Guest with `edit`: from the first focus on, the preview edits the file's shared doc. */
  function attachDoc() {
    if (!remote || !preview || !previewFile || releaseDoc || !remote.canEdit()) return;
    const file = previewFile;
    releaseDoc = remote.previewDoc(file, (ext, text) => {
      if (!preview || previewFile !== file) return;
      if (!ext) releaseDoc = null;
      const head = Math.min(preview.state.selection.main.head, (ext ? text : preview.state.doc.toString()).length);
      const focused = preview.hasFocus;
      preview.setState(previewState(ext ? text : preview.state.doc.toString(), file, ext ?? undefined));
      preview.dispatch({ selection: { anchor: head } });
      if (focused) preview.focus();
    });
  }

  function previewState(text: string, file: string, shared?: Extension) {
    const lang = langFor(file);
    return EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        // A shared doc has its own undo, the same one its tab uses.
        shared
          ? [shared, keymap.of([{ key: "Mod-z", run: (v) => runViewAction(v, "collab.undo") }, { key: "Mod-y", run: (v) => runViewAction(v, "collab.redo") }, { key: "Mod-Shift-z", run: (v) => runViewAction(v, "collab.redo") }, ...defaultKeymap])]
          : [history(), keymap.of([...defaultKeymap, ...historyKeymap])],
        lang ? lang.ext() : [],
        indentFor(lang),
        syntaxHighlighting(codeHighlight),
        baseTheme,
        highlighter,
        EditorView.editorAttributes.of({ class: "mode-code" }),
        // Until it's bound to the shared doc. Focus must stay possible for a guest who may edit.
        remote && !shared ? [EditorState.readOnly.of(true), remote.canEdit() ? [] : EditorView.editable.of(false)] : [],
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || !previewFile || remote) return;
          // Edits go straight into the file: open tabs get the same changes (undo + autosave),
          // other files are written after a short pause.
          const tab = app.tabs.find((t) => t.path === previewFile);
          for (const tr of u.transactions) if (tab && tr.docChanged) ed.applyChanges(tab.id, { changes: tr.changes });
          if (!tab) {
            const doc = u.state.doc, eol = previewEol;
            writer.schedule(previewFile, () => toDisk(doc.toString(), eol));
          }
        }),
      ],
    });
  }

  async function showPreview(h: Hit | undefined) {
    if (!preview || !h) return;
    if (previewFile !== h.file) {
      writer.flush(); // an edit in the previous file still goes to disk
      const tab = app.tabs.find((t) => t.path === h.file);
      let text: string;
      try {
        const read = tab ? ed.getText(tab.id) : remote ? await remote.read(h.file) : await fsApi.readFile(h.file);
        if (read === null) return;
        text = read;
      } catch {
        return;
      }
      if (hit !== h) return;
      detachDoc();
      previewFile = h.file;
      previewEol = detectEol(text);
      preview.setState(previewState(text, h.file));
    }
    const doc = preview.state.doc;
    if (h.line > doc.lines) return;
    const line = doc.line(h.line);
    const [a, b] = h.ranges[0] ?? [0, 0];
    preview.dispatch({
      selection: { anchor: Math.min(line.to, line.from + a), head: Math.min(line.to, line.from + b) },
      effects: [EditorView.scrollIntoView(line.from, { y: "center" }), refreshMatches.of(null)],
    });
  }

  $effect(() => {
    showPreview(hit);
  });

  // A new query (or option) rebuilds the highlights even before (or without) new hits.
  $effect(() => {
    void [find.query, find.caseSensitive, find.wholeWord, find.regex];
    preview?.dispatch({ effects: refreshMatches.of(null) });
  });

  onMount(() => {
    preview = new EditorView({ parent: previewHost!, state: EditorState.create({ doc: "" }) });
    // Re-run the search after editing in the preview (positions may have moved).
    preview.contentDOM.addEventListener("blur", () => runSearch(50));
    // Not only on focus: an element focused while the window isn't active gets no focus event.
    for (const type of ["focus", "mousedown", "keydown"]) preview.contentDOM.addEventListener(type, attachDoc);
  });
  onDestroy(() => {
    // Only a pending edit is written: an untouched preview must not overwrite a file changed on disk.
    writer.flush();
    detachDoc();
    preview?.destroy();
  });

  // ---------------------------------------------------------------- interaction

  function toggle(k: "caseSensitive" | "wholeWord" | "regex") {
    find[k] = !find[k];
    runSearch(0);
    input?.focus();
  }

  function setScope(s: typeof find.scope) {
    find.scope = s;
    runSearch(0);
  }

  async function chooseFolder() {
    if (remote) return setScope("folder"); // the folder of the active shared file (see openFind)
    const d = await openDialog({ directory: true, defaultPath: find.folder ?? app.root ?? undefined });
    if (typeof d === "string") {
      find.folder = normPath(d);
      setScope("folder");
    }
  }

  function close() {
    find.open = false;
    queueMicrotask(() => ed.focus());
  }

  function move(d: number) {
    if (!find.hits.length) return;
    find.selected = Math.max(0, Math.min(find.hits.length - 1, find.selected + d));
    tick().then(() => list?.querySelector(".hit.on")?.scrollIntoView({ block: "nearest" }));
  }

  async function replaceCurrent() {
    if (!hit) return;
    await writer.flush(); // the replacement reads the file: a pending preview edit lands first
    await replaceInFile(hit.file, hit.line);
    previewFile = null;
    runSearch(0);
  }

  function onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(10); }
    else if (e.key === "PageUp") { e.preventDefault(); move(-10); }
    else if (e.key === "Enter" && mod) { e.preventDefault(); dockResults(); }
    else if (e.key === "Enter" && e.altKey && e.shiftKey && find.replace) { e.preventDefault(); replaceAll(); }
    else if (e.key === "Enter") { e.preventDefault(); if (find.replace) replaceCurrent(); else if (hit) gotoHit(hit); }
    else if (e.altKey && e.key.toLowerCase() === "c") { e.preventDefault(); toggle("caseSensitive"); }
    else if (e.altKey && e.key.toLowerCase() === "w") { e.preventDefault(); toggle("wholeWord"); }
    else if (e.altKey && e.key.toLowerCase() === "x") { e.preventDefault(); toggle("regex"); }
  }

  /** Leading whitespace trimmed, match ranges shifted accordingly. */
  function segments(h: Hit) {
    const lead = h.text.length - h.text.trimStart().length;
    const text = h.text.slice(lead);
    const out: { t: string; m: boolean }[] = [];
    let pos = 0;
    for (const [a0, b0] of h.ranges) {
      const a = Math.max(0, a0 - lead), b = Math.max(0, b0 - lead);
      if (a > pos) out.push({ t: text.slice(pos, a), m: false });
      out.push({ t: text.slice(a, b), m: true });
      pos = b;
    }
    out.push({ t: text.slice(pos), m: false });
    return out;
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && find.open && !e.defaultPrevented && close()} />

<div class="backdrop" role="presentation" onclick={() => !find.pinned && close()}>
  <div class="popup" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <header>
      <span class="title">{find.replace ? t("git.search.replaceTitle") : t("git.search.findTitle")}</span>
      <span class="count">
        {#if find.error}<span class="err">{find.error}</span>
        {:else if find.query}{matchSummary(find.total, find.files, find.truncated ? "+" : "")}{find.running ? " …" : ""}{/if}
      </span>
      <span class="spacer"></span>
      <input class="mask" placeholder={t("git.search.maskPlaceholder")} bind:value={find.mask} oninput={() => runSearch()} spellcheck="false" title={t("git.search.maskTitle")} />
      <button class="icon" class:on={find.pinned} title={t("git.search.pin")} onclick={() => { find.pinned = !find.pinned; persistOptions(); }} aria-label="Pin">
        <svg width="14" height="14" viewBox="0 0 16 16"><path d="M9.5 1.5l5 5-2 .5-2.5 2.5.5 3-1.5 1.5-3-3-3.5 3.5M5 8L2.5 5.5 4 4l3 .5L9.5 2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon" title={t("git.search.closeEsc")} onclick={close} aria-label={t("common.close")}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </header>

    <div class="fields">
      <div class="field">
        <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input bind:this={input} bind:value={find.query} oninput={() => runSearch()} onkeydown={onKey} placeholder={t("git.search.placeholder")} spellcheck="false" />
        <button class="opt" class:on={find.caseSensitive} title={t("git.search.matchCase")} onclick={() => toggle("caseSensitive")}>Aa</button>
        <button class="opt" class:on={find.wholeWord} title={t("git.search.wholeWord")} onclick={() => toggle("wholeWord")}>W</button>
        <button class="opt" class:on={find.regex} title={t("git.search.regex")} onclick={() => toggle("regex")}>.*</button>
      </div>
      {#if find.replace}
        <div class="field">
          <svg width="14" height="14" viewBox="0 0 16 16"><path d="M2 5h9l-2.5-2.5M14 11H5l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <input bind:value={find.replacement} onkeydown={onKey} placeholder={find.regex ? t("git.search.replaceRegexPlaceholder") : t("git.search.replacePlaceholder")} spellcheck="false" />
        </div>
      {/if}
      <div class="scopes">
        <button class:on={find.scope === "project"} onclick={() => setScope("project")}>{t("git.search.scopeProject")}</button>
        <button class:on={find.scope === "folder"} onclick={() => (find.folder ? setScope("folder") : chooseFolder())} title={find.folder ?? ""}>
          {t("git.search.scopeFolder")}{#if find.scope === "folder" && find.folder}: <b>{folderName(find.folder)}</b>{/if}
        </button>
        {#if find.scope === "folder" && !remote}<button class="pick" onclick={chooseFolder} title={t("git.search.chooseFolder")}>…</button>{/if}
        <button class:on={find.scope === "open"} onclick={() => setScope("open")}>{t("git.search.scopeOpen")}</button>
      </div>
    </div>

    <div class="results" bind:this={list}>
      {#each find.hits.slice(0, 1000) as h, i (h.file + ":" + h.line + ":" + i)}
        <button class="hit" class:on={i === find.selected} onclick={() => (find.selected = i)} ondblclick={() => gotoHit(h)} title={rel(h.file)}>
          <span class="text">{#each segments(h) as s, k (k)}<span class:m={s.m}>{s.t}</span>{/each}</span>
          <span class="loc">{basename(rel(h.file))} <b>{h.line}</b></span>
        </button>
      {:else}
        <p class="empty">{find.query ? (find.running ? t("git.search.searching") : t("common.noResults")) : t("git.search.enterQuery")}</p>
      {/each}
      {#if remote && find.truncated}<p class="empty">{t("git.search.limited")}</p>{/if}
    </div>

    <div class="preview-head">
      {#if hit}
        <span class="pfile">{rel(hit.file)}</span>
        <span class="phint">{remote && !remote.canEdit() ? t("git.search.guestPreviewHint") : t("git.search.previewHint")}</span>
      {/if}
    </div>
    <div class="preview" bind:this={previewHost}></div>

    <footer>
      <span class="keys">{t("git.search.footerKeys", { action: find.replace ? t("git.search.actionReplace") : t("git.search.actionOpen"), key: formatKey("Mod-Enter") })}</span>
      <span class="spacer"></span>
      <button class="btn" onclick={dockResults} disabled={!find.hits.length}>{t("git.search.dock")}</button>
      {#if find.replace}
        <button class="btn" onclick={replaceCurrent} disabled={!hit}>{t("git.search.replace")}</button>
        <button class="btn primary" onclick={replaceAll} disabled={!find.hits.length}>{t("git.search.replaceAll")}</button>
      {:else if hit}
        <button class="btn primary" onclick={() => hit && gotoHit(hit)}>{t("common.open")}</button>
      {/if}
    </footer>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 85; display: grid; place-items: center; background: var(--scrim); }
  .popup {
    width: min(1100px, 92vw);
    height: min(860px, 88vh);
    display: flex;
    flex-direction: column;
    border-radius: 24px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: var(--glass-highlight), 0 30px 90px rgba(0, 0, 0, 0.7);
    overflow: hidden;
    outline: none;
    /* No open animation: fading/scaling glass (backdrop-filter) makes WebKitGTK flash. */
  }
  header { display: flex; align-items: center; gap: 10px; padding: 14px 14px 8px 20px; }
  .title { font-weight: 700; font-size: 14px; white-space: nowrap; flex-shrink: 0; }
  .count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--label-3); font-size: 12px; font-variant-numeric: tabular-nums; }
  .err { color: var(--red); }
  .spacer { flex: 1; }
  .mask { width: 220px; min-width: 100px; flex-shrink: 1; padding: 5px 12px; font-family: var(--mono); font-size: 12px; }
  .icon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; color: var(--label-2); }
  .icon:hover { background: var(--fill-hover); color: var(--label); }
  .icon.on { background: rgba(var(--fg-rgb), 0.14); color: var(--label); }
  .fields { display: flex; flex-direction: column; gap: 8px; padding: 0 16px 10px; }
  .field { display: flex; align-items: center; gap: 8px; padding: 0 6px 0 14px; height: 40px; border-radius: 14px; background: var(--recess); box-shadow: var(--recess-shadow); color: var(--label-3); }
  .field input { flex: 1; background: transparent; box-shadow: none !important; padding: 0; font-family: var(--mono); font-size: 13.5px; border-radius: 0; }
  .opt { height: 28px; min-width: 32px; padding: 0 8px; border-radius: 8px; font-family: var(--mono); font-size: 12px; color: var(--label-2); }
  .opt:hover { background: var(--fill-hover); }
  .opt.on { background: rgba(var(--fg-rgb), 0.16); color: var(--label); }
  .scopes { display: flex; gap: 4px; }
  .scopes button { height: 26px; padding: 0 12px; border-radius: 999px; font-size: 12px; color: var(--label-2); background: rgba(var(--fg-rgb), 0.04); }
  .scopes button:hover { background: rgba(var(--fg-rgb), 0.09); color: var(--label); }
  .scopes button.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  .scopes .pick { padding: 0 9px; }
  .results { flex: 0 0 34%; overflow: auto; padding: 4px 8px; border-top: 1px solid rgba(var(--fg-rgb), 0.05); }
  .hit { width: 100%; display: flex; align-items: center; gap: 16px; padding: 4px 10px; border-radius: 8px; text-align: left; font-family: var(--mono); font-size: 12.5px; }
  .hit:hover { background: rgba(var(--fg-rgb), 0.05); }
  .hit.on { background: rgba(var(--fg-rgb), 0.12); }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; color: var(--label-2); }
  .m { color: var(--label); background: rgba(216, 194, 122, 0.28); border-radius: 3px; }
  .loc { flex-shrink: 0; font-family: var(--font); font-size: 11.5px; color: var(--label-3); }
  .loc b { color: var(--label-2); font-weight: 500; }
  .empty { color: var(--label-3); padding: 12px; margin: 0; font-family: var(--font); font-size: 13px; }
  .preview-head { display: flex; align-items: baseline; gap: 12px; min-height: 30px; padding: 7px 20px 4px; border-top: 1px solid rgba(var(--fg-rgb), 0.06); }
  .pfile { font-family: var(--mono); font-size: 12px; color: var(--label-2); }
  .phint { font-size: 11px; color: var(--label-3); }
  .preview { flex: 1; min-height: 0; position: relative; background: var(--well); }
  .preview :global(.cm-editor) { position: absolute; inset: 0; }
  .preview :global(.find-match) { background: rgba(216, 194, 122, 0.3); border-radius: 2px; }
  footer { display: flex; align-items: center; gap: 8px; padding: 10px 14px 12px 20px; border-top: 1px solid rgba(var(--fg-rgb), 0.05); }
  .keys { min-width: 0; font-size: 11.5px; color: var(--label-3); }
  /* Button labels stay on one line; the key hint wraps instead. */
  footer .btn { white-space: nowrap; flex-shrink: 0; }
  .btn:disabled { opacity: 0.4; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes pop { from { opacity: 0; transform: scale(0.97); } }
</style>
