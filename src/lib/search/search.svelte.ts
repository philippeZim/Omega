/** Find/Replace in Files (PyCharm-style): live search, scopes, file mask, pinned results. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { app, openFile } from "../state.svelte";
import * as ed from "../editor";
import { fsApi, dirname } from "../api";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

export interface Hit {
  file: string;
  line: number;
  ranges: [number, number][];
  text: string;
}

export type Scope = "project" | "folder" | "open";

export const find = $state({
  open: false,
  replace: false,
  query: localStorage.getItem("find.query") ?? "",
  replacement: "",
  caseSensitive: localStorage.getItem("find.case") === "true",
  wholeWord: localStorage.getItem("find.word") === "true",
  regex: localStorage.getItem("find.regex") === "true",
  mask: localStorage.getItem("find.mask") ?? "",
  scope: "project" as Scope,
  folder: null as string | null,
  pinned: localStorage.getItem("find.pin") === "true",
  hits: [] as Hit[],
  files: 0,
  total: 0,
  running: false,
  truncated: false,
  error: null as string | null,
  selected: 0,
  /** Results "opened in the find window" (bottom panel tab). */
  docked: null as { query: string; hits: Hit[]; total: number; files: number } | null,
  showDocked: false,
});

let currentId = 0;
let idCounter = 0;
/** Unique search ids shared by Find in Files and Search Everywhere. */
export const nextSearchId = () => Date.now() * 100 + (idCounter++ % 100);
let pending: Hit[] = [];
let flushQueued = false;

listen<{ id: number; hits: Hit[] }>("search-hits", (e) => {
  if (e.payload.id !== currentId) return;
  pending.push(...e.payload.hits);
  if (!flushQueued) {
    flushQueued = true;
    requestAnimationFrame(() => {
      flushQueued = false;
      find.hits.push(...pending);
      pending = [];
    });
  }
});
listen<{ id: number; files: number; hits: number; truncated: boolean; error: string | null }>("search-done", (e) => {
  if (e.payload.id !== currentId) return;
  find.running = false;
  find.files = e.payload.files;
  find.total = e.payload.hits;
  find.truncated = e.payload.truncated;
  find.error = e.payload.error;
});

export function persistOptions() {
  localStorage.setItem("find.query", find.query);
  localStorage.setItem("find.case", String(find.caseSensitive));
  localStorage.setItem("find.word", String(find.wholeWord));
  localStorage.setItem("find.regex", String(find.regex));
  localStorage.setItem("find.mask", find.mask);
  localStorage.setItem("find.pin", String(find.pinned));
}

function searchRoot() {
  if (find.scope === "folder" && find.folder) return find.folder;
  return app.root ?? (app.tabs.find((t) => t.path)?.path ? dirname(app.tabs.find((t) => t.path)!.path!) : null);
}

let timer: number | undefined;
/** Debounced like PyCharm (100 ms). */
export function runSearch(delay = 100) {
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    persistOptions();
    const root = searchRoot();
    find.hits = [];
    pending = [];
    find.selected = 0;
    find.files = find.total = 0;
    find.truncated = false;
    find.error = null;
    if (!find.query || !root) {
      find.running = false;
      invoke("search_cancel");
      return;
    }
    find.running = true;
    const files = find.scope === "open" ? app.tabs.filter((t) => t.path).map((t) => t.path!) : [];
    if (find.scope === "open" && !files.length) {
      find.running = false;
      return;
    }
    currentId = nextSearchId();
    await invoke<number>("search_text", {
      id: currentId,
      root,
      opts: { query: find.query, caseSensitive: find.caseSensitive, wholeWord: find.wholeWord, regex: find.regex, mask: find.mask, files, maxResults: 5000 },
    });
  }, delay);
}

export function openFind(replace: boolean) {
  find.replace = replace;
  // Like PyCharm: the editor selection pre-fills the search field.
  const v = ed.getView();
  if (v) {
    const sel = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
    if (sel && !sel.includes("\n") && sel.length < 200) find.query = sel;
  }
  if (!find.folder) {
    const p = app.tabs.find((t) => t.id === app.activeId)?.path;
    find.folder = p ? dirname(p) : app.root;
  }
  find.open = true;
  runSearch(0);
}

export async function gotoHit(h: Hit, keepOpen = find.pinned) {
  if (!keepOpen) find.open = false;
  await openFile(h.file);
  const v = ed.getView();
  if (!v) return;
  const line = v.state.doc.line(Math.min(h.line, v.state.doc.lines));
  const [a, b] = h.ranges[0] ?? [0, 0];
  v.dispatch({ selection: { anchor: Math.min(line.to, line.from + a), head: Math.min(line.to, line.from + b) }, scrollIntoView: true });
  if (!keepOpen) v.focus();
}

export function dockResults() {
  find.docked = { query: find.query, hits: [...find.hits], total: find.total, files: find.files };
  find.showDocked = true;
  find.open = false;
}

// ------------------------------------------------------------------ replace

/** JS RegExp equivalent of the backend pattern (for replacing). */
export function buildRegex(global = true): RegExp | null {
  try {
    let src = find.regex ? find.query : find.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (find.wholeWord) src = `\\b(?:${src})\\b`;
    return new RegExp(src, (global ? "g" : "") + (find.caseSensitive ? "" : "i") + "u");
  } catch {
    return null;
  }
}

function replaceText(text: string, re: RegExp): { text: string; count: number } {
  let count = 0;
  const out = text.replace(re, (...args) => {
    count++;
    if (!find.regex) return find.replacement;
    // $1 … $9 / $& groups in regex mode
    const m = args.slice(0, -2) as string[];
    return find.replacement.replace(/\$(\d|&)/g, (_, g) => (g === "&" ? m[0] : (m[Number(g)] ?? "")));
  });
  return { text: out, count };
}

/** Replaces in one file (open tabs are edited in the editor, so undo works). Returns replacement count. */
export async function replaceInFile(file: string, onlyLine?: number): Promise<number> {
  const re = buildRegex();
  if (!re) return 0;
  const tab = app.tabs.find((t) => t.path === file);
  let original: string;
  if (tab) original = ed.getText(tab.id);
  else original = await fsApi.readFile(file);
  let result: { text: string; count: number };
  if (onlyLine !== undefined) {
    const lines = original.split("\n");
    const r = replaceText(lines[onlyLine - 1] ?? "", re);
    lines[onlyLine - 1] = r.text;
    result = { text: lines.join("\n"), count: r.count };
  } else result = replaceText(original, re);
  if (!result.count) return 0;
  if (tab) ed.replaceDocText(tab.id, result.text);
  else await fsApi.writeFile(file, result.text);
  return result.count;
}

/** "12 matches in 3 files" (localized); `suffix` is appended to the match count, e.g. "+" when truncated. */
export function matchSummary(total: number, files: number, suffix = ""): string {
  return t("git.search.summary", {
    matches: t(total === 1 && !suffix ? "git.search.matchOne" : "git.search.matchMany", { n: total + suffix }),
    files: filesLabel(files),
  });
}

const filesLabel = (n: number) => t(n === 1 ? "git.search.fileOne" : "git.search.fileMany", { n });

export async function replaceAll() {
  const files = [...new Set(find.hits.map((h) => h.file))];
  if (!files.length) return;
  const ok = await ui.confirm(t("git.search.replaceAllTitle"), t("git.search.replaceAllBody", { summary: matchSummary(find.total, files.length), text: find.replacement }), t("git.search.replaceAll"), true);
  if (!ok) return;
  let n = 0;
  for (const f of files) n += await replaceInFile(f);
  ui.toast(t("git.search.replaced", { n, files: filesLabel(files.length) }));
  runSearch(0);
}
