<script lang="ts">
  /** Search Everywhere (PyCharm): tabs All | Files | Symbols | Actions | Text. */
  import { tick, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "../lib/windowEvents";
  import { palette, availableCommands, keysFor, runCommand, type PaletteTab } from "../lib/commands.svelte";
  import { formatKey } from "../lib/keys";
  import { fuzzy, highlight } from "../lib/fuzzy";
  import { app, openFile, recent } from "../lib/state.svelte";
  import { joinPath, basename } from "../lib/api";
  import { allClients, workspaceSymbols } from "../lib/code/lsp.svelte";
  import { remoteLsp } from "../lib/code/remoteLsp";
  import { collab } from "../lib/collab/collab.svelte";
  import { openFind, find, nextSearchId } from "../lib/search/search.svelte";
  import { activeRemote } from "../lib/search/remote";
  import * as ed from "../lib/editor";
  import { t, type Key } from "../lib/i18n/index.svelte";

  const TABS: { id: PaletteTab; label: Key }[] = [
    { id: "all", label: "commands.palette.all" },
    { id: "files", label: "commands.palette.files" },
    { id: "symbols", label: "commands.palette.symbols" },
    { id: "actions", label: "commands.palette.actions" },
    { id: "text", label: "commands.palette.text" },
  ];

  let query = $state("");
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let selected = $state(0);
  let files = $state<string[]>([]);
  let symbols = $state<Item[]>([]);
  let textHits = $state<Item[]>([]);

  tick().then(() => input?.focus());
  /** A guest in a session searches the host's project. */
  const remote = activeRemote();
  let limited = $state(false);
  const listRun = new AbortController();
  if (remote) {
    remote.listFiles(listRun.signal).then((r) => {
      if (!r.ok) return;
      files = r.value.files;
      limited = r.value.truncated;
    });
  } else if (app.root) invoke<string[]>("list_files", { root: app.root }).then((f) => (files = f));

  interface Item {
    kind: "file" | "cmd" | "symbol" | "text";
    key: string;
    label: string;
    detail: string;
    positions: number[];
    score: number;
    path?: string;
    line?: number;
    col?: number;
    cmd?: string;
  }

  const rel = (p: string) => (app.root && p.startsWith(app.root + "/") ? p.slice(app.root.length + 1) : p);
  const SYMBOL_KIND: Record<number, string> = { 5: "class", 6: "method", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 23: "struct", 26: "type" };

  // ------------------------------------------------------------ sources

  function fileItems(q: string): Item[] {
    const lm = /^(.*?):(\d+)(?::(\d+))?$/.exec(q);
    const term = lm ? lm[1] : q;
    if (!term) {
      // Empty query: recent files first, like PyCharm.
      return recent
        .filter((p) => (remote ? p.startsWith("collab:") : !app.root || p.startsWith(app.root)))
        .slice(0, 20)
        .map((p, i) => ({ kind: "file" as const, key: "r" + p, label: basename(p), detail: rel(p), positions: [], score: 100 - i, path: p }));
    }
    const recentSet = new Set(recent);
    return files
      .map((f) => {
        const m = fuzzy(term, f);
        if (!m) return null;
        const path = remote ? `collab:${f}` : joinPath(app.root!, f);
        const name = basename(f);
        const off = f.length - name.length;
        return {
          kind: "file" as const,
          key: f,
          label: name,
          detail: f.slice(0, off),
          positions: m.positions.filter((p) => p >= off).map((p) => p - off),
          score: m.score + (recentSet.has(path) ? 20 : 0),
          path,
          line: lm ? Number(lm[2]) : undefined,
          col: lm?.[3] ? Number(lm[3]) : undefined,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
  }

  function actionItems(q: string): Item[] {
    return availableCommands()
      .map((c) => {
        const m = fuzzy(q, c.label);
        const keys = keysFor(c.id);
        return m && { kind: "cmd" as const, key: c.id, label: c.label, detail: keys.length ? formatKey(keys[0]) : c.group, positions: m.positions, score: m.score, cmd: c.id };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }

  let symTimer: number | undefined;
  function loadSymbols(q: string) {
    clearTimeout(symTimer);
    if (!q) return (symbols = []);
    symTimer = window.setTimeout(async () => {
      const out: Item[] = [];
      for (const s of (await remoteLsp.symbols?.(q)) ?? (await workspaceSymbols(q))) {
        const m = fuzzy(q, s.name) ?? { score: 0, positions: [] };
        out.push({
          kind: "symbol", key: `${s.path}:${s.name}:${s.line}:${s.character}`, label: s.name,
          detail: `${t(`commands.palette.kind.${SYMBOL_KIND[s.kind] ?? "symbol"}` as Key)}${s.containerName ? " · " + s.containerName : ""} — ${rel(s.path)}`,
          positions: m.positions, score: m.score, path: s.path, line: s.line + 1, col: s.character + 1,
        });
      }
      if (query.trim() === q) symbols = out.sort((a, b) => b.score - a.score).slice(0, 80);
    }, 150);
  }

  // Text tab: small live search via the same backend as Find in Files.
  let textId = 0;
  const unlisten = [
    listen<{ id: number; hits: any[] }>("search-hits", (e) => {
      if (e.payload.id !== textId) return;
      textHits = [...textHits, ...e.payload.hits.map((h) => ({ kind: "text" as const, key: `${h.file}:${h.line}`, label: h.text.trim(), detail: `${basename(h.file)}:${h.line}`, positions: [], score: 0, path: h.file, line: h.line, col: (h.ranges[0]?.[0] ?? 0) + 1 }))].slice(0, 100);
    }),
  ];
  let textRun: AbortController | null = null;
  onDestroy(() => {
    unlisten.forEach((p) => p.then((f) => f()));
    listRun.abort();
    textRun?.abort();
  });
  let textTimer: number | undefined;
  function loadText(q: string) {
    clearTimeout(textTimer);
    textRun?.abort();
    textHits = [];
    if (q.length < 2 || (!remote && !app.root)) return;
    textTimer = window.setTimeout(async () => {
      if (remote) {
        const run = (textRun = new AbortController());
        const r = await remote.text({ query: q, caseSensitive: false, wholeWord: false, regex: false, mask: "", folder: "", maxResults: 100 }, run.signal);
        if (run.signal.aborted || !r.ok) return;
        limited = r.value.truncated;
        textHits = r.value.hits.map((h) => ({ kind: "text" as const, key: `${h.file}:${h.line}`, label: h.text.trim(), detail: `${basename(h.file.slice("collab:".length))}:${h.line}`, positions: [], score: 0, path: h.file, line: h.line, col: (h.ranges[0]?.[0] ?? 0) + 1 }));
        return;
      }
      textId = nextSearchId();
      await invoke<number>("search_text", { id: textId, root: app.root, opts: { query: q, caseSensitive: false, wholeWord: false, regex: false, mask: "", files: [], maxResults: 100 } });
    }, 150);
  }

  $effect(() => {
    const q = query.trim();
    selected = 0;
    if (palette.tab === "symbols" || palette.tab === "all") loadSymbols(q);
    if (palette.tab === "text" || palette.tab === "all") loadText(q);
  });

  const sections = $derived.by((): { title: string; items: Item[] }[] => {
    const q = query.trim();
    switch (palette.tab) {
      case "files": return [{ title: "", items: fileItems(q) }];
      case "actions": return [{ title: "", items: actionItems(q) }];
      case "symbols": return [{ title: "", items: symbols }];
      case "text": return [{ title: "", items: textHits }];
      default:
        return [
          { title: t(q ? "commands.palette.files" : "commands.palette.recent"), items: fileItems(q).slice(0, q ? 8 : 12) },
          { title: t("commands.palette.symbols"), items: symbols.slice(0, 6) },
          { title: t("commands.palette.actions"), items: q ? actionItems(q).slice(0, 6) : [] },
          { title: t("commands.palette.text"), items: textHits.slice(0, 8) },
        ].filter((s) => s.items.length);
    }
  });
  const visible = $derived(sections.filter((s) => s.items.length));
  const flat = $derived(visible.flatMap((s) => s.items));

  function close() {
    palette.open = false;
    queueMicrotask(() => ed.focus());
  }

  async function choose(it: Item | undefined) {
    if (!it) return;
    palette.open = false;
    if (it.kind === "cmd") return runCommand(it.cmd!);
    // A shared file may still have to arrive from the host: it gets the position when it does.
    if (it.kind === "symbol" && it.path!.startsWith("collab:") && remoteLsp.openAt) return remoteLsp.openAt(it.path!, it.line ?? 1, it.col ?? 1);
    if (remote && it.path?.startsWith("collab:") && it.line) {
      const col = (it.col ?? 1) - 1;
      return remote.reveal(it.path, it.line, [col, col]);
    }
    await openFile(it.path!, false, !!it.line);
    const v = ed.getView();
    if (v && it.line) {
      const l = v.state.doc.line(Math.min(it.line, v.state.doc.lines));
      v.dispatch({ selection: { anchor: Math.min(l.to, l.from + (it.col ? it.col - 1 : 0)) }, scrollIntoView: true });
    }
    v?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") return (e.preventDefault(), close());
    if (e.key === "Tab") {
      const i = TABS.findIndex((x) => x.id === palette.tab);
      palette.tab = TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id;
    } else if (e.key === "ArrowDown") selected = Math.min(flat.length - 1, selected + 1);
    else if (e.key === "ArrowUp") selected = Math.max(0, selected - 1);
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && palette.tab === "text") {
      // Like PyCharm: continue in the full Find in Files window.
      palette.open = false;
      find.query = query;
      openFind(false);
    } else if (e.key === "Enter") choose(flat[selected]);
    else return;
    e.preventDefault();
    tick().then(() => list?.querySelector(".item.on")?.scrollIntoView({ block: "nearest" }));
  }

  const PLACEHOLDER: Record<PaletteTab, Key> = {
    all: "commands.palette.phAll",
    files: "commands.palette.phFiles",
    symbols: "commands.palette.phSymbols",
    actions: "commands.palette.phActions",
    text: "commands.palette.phText",
  };
</script>

<div class="backdrop" role="presentation" onclick={close}>
  <div class="palette" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <nav class="tabs">
      {#each TABS as tab (tab.id)}
        <button class:on={palette.tab === tab.id} onclick={() => { palette.tab = tab.id; input?.focus(); }}>{t(tab.label)}</button>
      {/each}
      <span class="tabhint">{t("commands.palette.tabHint")}</span>
    </nav>
    <div class="search">
      <svg width="15" height="15" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input bind:this={input} bind:value={query} onkeydown={onKey} spellcheck="false" placeholder={t(PLACEHOLDER[palette.tab])} />
    </div>
    <div class="list" bind:this={list}>
      {#each visible as sec (sec.title)}
        {#if sec.title}<div class="sec">{sec.title}</div>{/if}
        {#each sec.items as it (it.kind + it.key)}
          {@const idx = flat.indexOf(it)}
          <button class="item" class:on={idx === selected} onmouseenter={() => (selected = idx)} onclick={() => choose(it)}>
            <span class="badge {it.kind}">{it.kind === "file" ? t("commands.palette.badgeFile") : it.kind === "cmd" ? "›" : it.kind === "symbol" ? "S" : "T"}</span>
            <span class="name" class:mono={it.kind === "text" || it.kind === "symbol"}>{#each highlight(it.label, it.positions) as seg, k (k)}<span class:m={seg.m}>{seg.t}</span>{/each}</span>
            <span class="detail" class:right={it.kind === "cmd" || it.kind === "text"}>{it.detail}{it.kind === "file" && it.line ? `  :${it.line}` : ""}</span>
          </button>
        {/each}
      {:else}
        <p class="empty">
          {#if !remote && !app.root && (palette.tab === "files" || palette.tab === "text")}{t("commands.palette.openFolderFirst")}
          {:else if palette.tab === "symbols" && !allClients().length && collab.role !== "guest"}{t("commands.palette.symbolsNeedLsp")}
          {:else if query}{t("common.noResults")}{:else}{t("commands.palette.typeToSearch")}{/if}
        </p>
      {/each}
      {#if remote && limited}<p class="empty">{t("commands.palette.limited")}</p>{/if}
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 95; display: flex; justify-content: center; padding-top: 11vh; background: var(--scrim); }
  .palette { width: min(720px, 92vw); max-height: 66vh; display: flex; flex-direction: column; border-radius: 22px; background: var(--glass-strong); backdrop-filter: var(--blur); box-shadow: var(--glass-highlight), 0 30px 80px rgba(0, 0, 0, 0.65); overflow: hidden; outline: none; /* no open animation: WebKitGTK flashes when glass animates */ }
  .tabs { display: flex; align-items: center; gap: 4px; padding: 10px 12px 0; }
  .tabs button { height: 28px; padding: 0 13px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--label-2); transition: background 0.2s, color 0.2s; }
  .tabs button:hover { color: var(--label); background: rgba(var(--fg-rgb), 0.07); }
  .tabs button.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  .tabhint { margin-left: auto; font-size: 11px; color: var(--label-3); padding-right: 6px; }
  .search { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid rgba(var(--fg-rgb), 0.06); color: var(--label-2); }
  .search input { flex: 1; background: transparent; box-shadow: none !important; padding: 4px 0; font-size: 15px; border-radius: 0; }
  .list { overflow: auto; padding: 6px; }
  .sec { padding: 10px 12px 4px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--label-3); }
  .item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 12px; text-align: left; }
  .item.on { background: rgba(var(--fg-rgb), 0.1); }
  .badge { width: 20px; height: 20px; flex-shrink: 0; display: grid; place-items: center; border-radius: 6px; font-size: 10.5px; font-weight: 700; background: rgba(var(--fg-rgb), 0.07); color: var(--label-2); }
  .badge.symbol { color: var(--purple); }
  .badge.file { color: var(--teal); }
  .badge.text { color: var(--yellow); }
  .name { color: var(--label); font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%; }
  .name.mono { font-family: var(--mono); font-size: 12.5px; }
  .m { color: var(--accent); font-weight: 650; }
  .detail { color: var(--label-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Shortcuts and file:line are short: let the name shrink instead (a very long file name still ellipsizes at 50%). */
  .detail.right { margin-left: auto; flex-shrink: 0; max-width: 50%; }
  .empty { color: var(--label-3); padding: 14px; margin: 0; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes drop { from { opacity: 0; transform: translateY(-10px) scale(0.98); } }
</style>
