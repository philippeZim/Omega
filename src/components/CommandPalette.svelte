<script lang="ts">
  /** Search Everywhere (PyCharm): tabs All | Files | Symbols | Actions | Text. */
  import { tick, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { palette, availableCommands, keysFor, runCommand, type PaletteTab } from "../lib/commands.svelte";
  import { formatKey } from "../lib/keys";
  import { fuzzy, highlight } from "../lib/fuzzy";
  import { app, openFile, recent } from "../lib/state.svelte";
  import { joinPath, basename } from "../lib/api";
  import { allClients, uriPath } from "../lib/code/lsp.svelte";
  import { openFind, find, nextSearchId } from "../lib/search/search.svelte";
  import * as ed from "../lib/editor";

  const TABS: { id: PaletteTab; label: string }[] = [
    { id: "all", label: "Alle" },
    { id: "files", label: "Dateien" },
    { id: "symbols", label: "Symbole" },
    { id: "actions", label: "Aktionen" },
    { id: "text", label: "Text" },
  ];

  let query = $state("");
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let selected = $state(0);
  let files = $state<string[]>([]);
  let symbols = $state<Item[]>([]);
  let textHits = $state<Item[]>([]);

  tick().then(() => input?.focus());
  if (app.root) invoke<string[]>("list_files", { root: app.root }).then((f) => (files = f));

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
  const SYMBOL_KIND: Record<number, string> = { 5: "Klasse", 6: "Methode", 9: "Konstruktor", 10: "Enum", 11: "Interface", 12: "Funktion", 13: "Variable", 14: "Konstante", 23: "Struct", 26: "Typ" };

  // ------------------------------------------------------------ sources

  function fileItems(q: string): Item[] {
    const lm = /^(.*?):(\d+)(?::(\d+))?$/.exec(q);
    const term = lm ? lm[1] : q;
    if (!term) {
      // Empty query: recent files first, like PyCharm.
      return recent
        .filter((p) => !app.root || p.startsWith(app.root))
        .slice(0, 20)
        .map((p, i) => ({ kind: "file" as const, key: "r" + p, label: basename(p), detail: rel(p), positions: [], score: 100 - i, path: p }));
    }
    const recentSet = new Set(recent);
    return files
      .map((f) => {
        const m = fuzzy(term, f);
        if (!m) return null;
        const path = joinPath(app.root!, f);
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
      for (const c of allClients()) {
        const res: any[] = await c.request("workspace/symbol", { query: q }, 4000).catch(() => []);
        for (const s of res ?? []) {
          const loc = s.location;
          const path = loc?.uri ? uriPath(loc.uri) : null;
          if (!path) continue;
          const m = fuzzy(q, s.name) ?? { score: 0, positions: [] };
          out.push({
            kind: "symbol", key: `${path}:${s.name}:${loc.range?.start?.line}`, label: s.name,
            detail: `${SYMBOL_KIND[s.kind] ?? "Symbol"}${s.containerName ? " · " + s.containerName : ""} — ${rel(path)}`,
            positions: m.positions, score: m.score, path, line: (loc.range?.start?.line ?? 0) + 1, col: (loc.range?.start?.character ?? 0) + 1,
          });
        }
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
  onDestroy(() => unlisten.forEach((p) => p.then((f) => f())));
  let textTimer: number | undefined;
  function loadText(q: string) {
    clearTimeout(textTimer);
    textHits = [];
    if (q.length < 2 || !app.root) return;
    textTimer = window.setTimeout(async () => {
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
          { title: q ? "Dateien" : "Zuletzt geöffnet", items: fileItems(q).slice(0, q ? 8 : 12) },
          { title: "Symbole", items: symbols.slice(0, 6) },
          { title: "Aktionen", items: q ? actionItems(q).slice(0, 6) : [] },
          { title: "Text", items: textHits.slice(0, 8) },
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
    await openFile(it.path!);
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
      const i = TABS.findIndex((t) => t.id === palette.tab);
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

  const PLACEHOLDER: Record<PaletteTab, string> = {
    all: "Überall suchen…",
    files: "Datei suchen…  (datei.py:42 springt zur Zeile)",
    symbols: "Klasse, Funktion, Variable…",
    actions: "Aktion suchen…",
    text: "Text in Dateien suchen…  (Strg+Enter: großes Suchfenster)",
  };
</script>

<div class="backdrop" role="presentation" onclick={close}>
  <div class="palette" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <nav class="tabs">
      {#each TABS as t (t.id)}
        <button class:on={palette.tab === t.id} onclick={() => { palette.tab = t.id; input?.focus(); }}>{t.label}</button>
      {/each}
      <span class="tabhint">Tab wechselt</span>
    </nav>
    <div class="search">
      <svg width="15" height="15" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input bind:this={input} bind:value={query} onkeydown={onKey} spellcheck="false" placeholder={PLACEHOLDER[palette.tab]} />
    </div>
    <div class="list" bind:this={list}>
      {#each visible as sec (sec.title)}
        {#if sec.title}<div class="sec">{sec.title}</div>{/if}
        {#each sec.items as it (it.kind + it.key)}
          {@const idx = flat.indexOf(it)}
          <button class="item" class:on={idx === selected} onmouseenter={() => (selected = idx)} onclick={() => choose(it)}>
            <span class="badge {it.kind}">{it.kind === "file" ? "D" : it.kind === "cmd" ? "›" : it.kind === "symbol" ? "S" : "T"}</span>
            <span class="name" class:mono={it.kind === "text" || it.kind === "symbol"}>{#each highlight(it.label, it.positions) as seg, k (k)}<span class:m={seg.m}>{seg.t}</span>{/each}</span>
            <span class="detail" class:right={it.kind === "cmd" || it.kind === "text"}>{it.detail}{it.kind === "file" && it.line ? `  :${it.line}` : ""}</span>
          </button>
        {/each}
      {:else}
        <p class="empty">
          {#if !app.root && (palette.tab === "files" || palette.tab === "text")}Öffne zuerst einen Ordner.
          {:else if palette.tab === "symbols" && !allClients().length}Symbole kommen vom Language Server – öffne eine Code-Datei.
          {:else if query}Keine Treffer{:else}Tippe zum Suchen{/if}
        </p>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 95; display: flex; justify-content: center; padding-top: 11vh; background: rgba(0, 0, 0, 0.35); animation: fade 0.15s ease-out; }
  .palette { width: min(720px, 92vw); max-height: 66vh; display: flex; flex-direction: column; border-radius: 22px; background: var(--glass-strong); backdrop-filter: var(--blur); box-shadow: var(--glass-highlight), 0 30px 80px rgba(0, 0, 0, 0.65); overflow: hidden; outline: none; animation: drop 0.25s cubic-bezier(0.22, 1.2, 0.36, 1); }
  .tabs { display: flex; align-items: center; gap: 4px; padding: 10px 12px 0; }
  .tabs button { height: 28px; padding: 0 13px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--label-2); transition: background 0.2s, color 0.2s; }
  .tabs button:hover { color: var(--label); background: rgba(255, 255, 255, 0.07); }
  .tabs button.on { color: #fff; background: rgba(255, 255, 255, 0.15); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12); }
  .tabhint { margin-left: auto; font-size: 11px; color: var(--label-3); padding-right: 6px; }
  .search { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); color: var(--label-2); }
  .search input { flex: 1; background: transparent; box-shadow: none !important; padding: 4px 0; font-size: 15px; border-radius: 0; }
  .list { overflow: auto; padding: 6px; }
  .sec { padding: 10px 12px 4px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--label-3); }
  .item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 12px; text-align: left; }
  .item.on { background: rgba(255, 255, 255, 0.1); }
  .badge { width: 20px; height: 20px; flex-shrink: 0; display: grid; place-items: center; border-radius: 6px; font-size: 10.5px; font-weight: 700; background: rgba(255, 255, 255, 0.07); color: var(--label-2); }
  .badge.symbol { color: var(--purple); }
  .badge.file { color: var(--teal); }
  .badge.text { color: var(--yellow); }
  .name { color: var(--label); font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%; }
  .name.mono { font-family: var(--mono); font-size: 12.5px; }
  .m { color: var(--accent); font-weight: 650; }
  .detail { color: var(--label-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail.right { margin-left: auto; }
  .empty { color: var(--label-3); padding: 14px; margin: 0; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes drop { from { opacity: 0; transform: translateY(-10px) scale(0.98); } }
</style>
