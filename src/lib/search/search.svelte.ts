/** Find/Replace in Files (PyCharm-style): live search, scopes, file mask, pinned results. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { app, openFile } from "../state.svelte";
import * as ed from "../editor";
import { fsApi, dirname } from "../api";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";
import { activeRemote, type RemoteQuery, type RemoteSearch, type ReplaceReport } from "./remote";

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

const GUEST_ROOT = "collab:";

function searchRoot() {
  // A guest's folder means nothing to the local search once the session is over.
  if (find.scope === "folder" && find.folder && !find.folder.startsWith(GUEST_ROOT)) return find.folder;
  return app.root ?? (app.tabs.find((t) => t.path)?.path ? dirname(app.tabs.find((t) => t.path)!.path!) : null);
}

/** Backend search options for the current query, scope and mask. */
function searchOpts() {
  const files = find.scope === "open" ? app.tabs.filter((t) => t.path).map((t) => t.path!) : [];
  return { query: find.query, caseSensitive: find.caseSensitive, wholeWord: find.wholeWord, regex: find.regex, mask: find.mask, files, maxResults: 5000 };
}

/** The same search as `searchOpts`, for the host of a Code Together session. */
function remoteQuery(): RemoteQuery {
  const folder = find.scope === "folder" && find.folder?.startsWith(GUEST_ROOT) ? find.folder.slice(GUEST_ROOT.length) : "";
  const files = find.scope === "open" ? app.tabs.filter((x) => x.path?.startsWith(GUEST_ROOT) && !x.path.startsWith(GUEST_ROOT + "tab:")).map((x) => x.path!) : undefined;
  return { query: find.query, caseSensitive: find.caseSensitive, wholeWord: find.wholeWord, regex: find.regex, mask: find.mask, folder, ...(files ? { files } : {}), maxResults: 5000 };
}

let remoteRun: AbortController | null = null;

async function runRemoteSearch(remote: RemoteSearch) {
  const q = remoteQuery();
  if (q.files && !q.files.length) {
    find.running = false;
    return;
  }
  const id = (currentId = nextSearchId());
  const run = (remoteRun = new AbortController());
  const r = await remote.text(q, run.signal);
  if (id !== currentId || run.signal.aborted) return;
  find.running = false;
  if (!r.ok) {
    find.error = r.message;
    return;
  }
  find.hits = r.value.hits;
  find.files = r.value.files;
  find.total = r.value.total;
  find.truncated = r.value.truncated;
}

let timer: number | undefined;
/** Debounced like PyCharm (100 ms). */
export function runSearch(delay = 100) {
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    persistOptions();
    remoteRun?.abort();
    remoteRun = null;
    const remote = activeRemote();
    const root = remote ? GUEST_ROOT : searchRoot();
    find.hits = [];
    pending = [];
    find.selected = 0;
    find.files = find.total = 0;
    find.truncated = false;
    find.error = null;
    if (!find.query || !root) {
      find.running = false;
      if (!remote) invoke("search_cancel");
      return;
    }
    find.running = true;
    if (remote) return runRemoteSearch(remote);
    const opts = searchOpts();
    if (find.scope === "open" && !opts.files.length) {
      find.running = false;
      return;
    }
    currentId = nextSearchId();
    await invoke<number>("search_text", { id: currentId, root, opts });
  }, delay);
}

function guestFolder() {
  const p = app.tabs.find((x) => x.id === app.activeId)?.path;
  const rel = p?.startsWith(GUEST_ROOT) && !p.startsWith(GUEST_ROOT + "tab:") ? p.slice(GUEST_ROOT.length) : "";
  return GUEST_ROOT + (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
}

export function openFind(replace: boolean) {
  find.replace = replace;
  // Like PyCharm: the editor selection pre-fills the search field.
  const v = ed.getView();
  if (v) {
    const sel = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
    if (sel && !sel.includes("\n") && sel.length < 200) find.query = sel;
  }
  const remote = activeRemote();
  if (remote) {
    // The folder of the active shared file; a local folder can't be searched on the host.
    if (!find.folder?.startsWith(GUEST_ROOT)) find.folder = guestFolder();
  } else if (!find.folder || find.folder.startsWith(GUEST_ROOT)) {
    const p = app.tabs.find((t) => t.id === app.activeId)?.path;
    find.folder = p ? dirname(p) : app.root;
  }
  find.open = true;
  runSearch(0);
}

export async function gotoHit(h: Hit, keepOpen = find.pinned) {
  if (!keepOpen) find.open = false;
  const remote = activeRemote();
  if (remote) return remote.reveal(h.file, h.line, h.ranges[0]);
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

/** A Unicode word character as Rust's `regex` crate defines `\w` (UTS #18), which the backend's `\b` uses. */
const W = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`;
/** Unicode-aware `\b`: JS's own `\b` only knows ASCII word characters, even with the `u` flag. */
const WORD_BOUNDARY = String.raw`(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

/** JS RegExp equivalent of the backend pattern (for replacing). */
export function buildRegex(global = true): RegExp | null {
  try {
    let src = find.regex ? find.query : find.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (find.wholeWord) src = `${WORD_BOUNDARY}(?:${src})${WORD_BOUNDARY}`;
    return new RegExp(src, (global ? "g" : "") + (find.caseSensitive ? "" : "i") + "u");
  } catch {
    return null;
  }
}

function replaceText(text: string, re: RegExp): { text: string; count: number } {
  if (!find.regex) {
    let count = 0;
    const out = text.replace(re, () => (count++, find.replacement));
    return { text: out, count };
  }
  // Regex mode: the native replacement string handles $1, $<name>, $&, $$ etc. correctly.
  const count = [...text.matchAll(re)].length;
  return { text: count ? text.replace(re, find.replacement) : text, count };
}

/** Replaces in one file (open tabs are edited in the editor, so undo works). Returns replacement count. */
export async function replaceInFile(file: string, onlyLine?: number): Promise<number> {
  const remote = activeRemote();
  if (remote) {
    if (!remote.mayReplace()) return 0;
    const report = await remote.replace(remoteQuery(), find.replacement, [file], onlyLine);
    toastReplaceProblems(report, 1, false);
    return report.replaced;
  }
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

/** What didn't work in a guest's Replace, so no file fails silently. */
function toastReplaceProblems(r: ReplaceReport, total: number, limited: boolean) {
  if (r.stopped) ui.toast(t("git.search.replaceStopped", { done: r.done, total, reason: r.stopped }), "error");
  if (r.errors.length) {
    const shown = r.errors.slice(0, 5).map((e) => `${e.file}: ${e.message}`).join("; ");
    ui.toast(t("git.search.replaceErrors", { failed: r.errors.length, total, list: shown + (r.errors.length > 5 ? "; …" : "") }), "error");
  }
  if (limited) ui.toast(t("git.search.replaceLimited", { n: total }), "error");
}

async function replaceAllRemote(remote: RemoteSearch) {
  if (!remote.mayReplace()) return;
  const q = remoteQuery();
  const m = await remote.matching(q);
  if (!m.ok) return ui.toast(m.message, "error");
  const { files, truncated } = m.value;
  if (!files.length) return;
  const more = find.truncated || truncated;
  const ok = await ui.confirm(t("git.search.replaceAllTitle"), t("git.search.replaceAllBody", { summary: matchSummary(find.total, files.length, more ? "+" : ""), text: find.replacement }), t("git.search.replaceAll"), true);
  if (!ok) return;
  const report = await remote.replace(q, find.replacement, files);
  if (report.replaced) ui.toast(t("git.search.replaced", { n: report.replaced, files: filesLabel(report.changed) }));
  toastReplaceProblems(report, files.length, truncated);
  runSearch(0);
}

export async function replaceAll() {
  const remote = activeRemote();
  if (remote) return replaceAllRemote(remote);
  let files = [...new Set(find.hits.map((h) => h.file))];
  if (!files.length) return;
  // The hit list stops at the cap: ask the backend for every file with a match, so none is skipped.
  const root = searchRoot();
  if (find.truncated && root) {
    try {
      files = await invoke<string[]>("search_files", { root, opts: searchOpts() });
    } catch (e) {
      ui.toast(String(e), "error");
      return;
    }
  }
  const ok = await ui.confirm(t("git.search.replaceAllTitle"), t("git.search.replaceAllBody", { summary: matchSummary(find.total, files.length, find.truncated ? "+" : ""), text: find.replacement }), t("git.search.replaceAll"), true);
  if (!ok) return;
  let n = 0;
  for (const f of files) n += await replaceInFile(f);
  ui.toast(t("git.search.replaced", { n, files: filesLabel(files.length) }));
  runSearch(0);
}
