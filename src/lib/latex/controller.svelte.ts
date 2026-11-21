/** Live LaTeX compilation: debounced compile of the active buffer, diagnostics, SyncTeX lookup, outline. */
import { ensureTools } from "../tools.svelte";
import { t } from "../i18n/index.svelte";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onFilesChanged } from "../fsWatch.svelte";
import { setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import * as ed from "../editor";
import { outline, type OutlineItem } from "./language";
import { onGuestChange, pausedBy, resumeCompiling } from "../collab/guestChanges";
import { ui } from "../ui.svelte";

export interface TexDiagnostic {
  file: string;
  line: number;
  message: string;
  severity: "error" | "warning";
}
export interface SyncBox {
  page: number;
  file: string;
  line: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface CompileResult {
  ok: boolean;
  pdf: string | null;
  diagnostics: TexDiagnostic[];
  log: string;
  sync: SyncBox[];
  millis: number;
}

export const latex = $state({
  available: null as boolean | null,
  status: "idle" as "idle" | "compiling" | "ok" | "error",
  millis: 0,
  pdf: null as string | null,
  /** Bumps on every successful compile so the viewer reloads. */
  pdfVersion: 0,
  diagnostics: [] as TexDiagnostic[],
  log: "",
  dark: localStorage.getItem("pdfDark") !== "false",
  outline: [] as OutlineItem[],
  /** Forward-sync target the PDF viewer should scroll to. */
  target: null as { page: number; x: number; y: number; w: number; h: number; seq: number } | null,
  /** Live progress of a slow (online) compile; null while idle or for the fast cached compile. */
  progress: null as LatexProgress | null,
  /** Who changed this document without being allowed to compile: it waits for the host's Compile. */
  pausedBy: null as string | null,
  /** That guest's change came while this result was compiling, so the PDF may already hold it. */
  guestInRun: false,
});

export interface LatexProgress {
  phase: "format" | "download" | "tex" | "rerun" | "pdf" | "write";
  downloads: number;
  file: string | null;
  /** 0–100, never decreasing within a compile. */
  percent: number;
}

/**
 * Tectonic can't know how many files it will fetch, so the bar is an estimate: the first-run
 * format build (~250 files) fills most of it, later phases jump to fixed marks.
 */
function estimate(phase: LatexProgress["phase"], downloads: number): number {
  const ease = (n: number, k: number) => 1 - Math.exp(-n / k);
  switch (phase) {
    case "format": return 3 + 52 * ease(downloads, 110);
    case "download": return 55 + 20 * ease(downloads, 150);
    case "tex": return 58;
    case "rerun": return 80;
    case "pdf": return 88 + 8 * ease(downloads, 20);
    case "write": return 98;
  }
}

/** One progress step of the running compile. */
export function applyProgress(p: { phase: LatexProgress["phase"]; downloads: number; file: string | null }) {
  if (latex.status !== "compiling") return;
  const percent = Math.max(latex.progress?.percent ?? 0, estimate(p.phase, p.downloads));
  latex.progress = { ...p, percent };
}

listen<{ phase: LatexProgress["phase"]; downloads: number; file: string | null }>("latex-progress", ({ payload: p }) => applyProgress(p));

/** A Code Together guest's tabs ("collab:…") compile on the host, see collab/latexRemote.svelte.ts. */
export const remoteLatex = {
  compile: null as ((path: string) => Promise<{ result: CompileResult; bytes: Uint8Array | null }>) | null,
  cancel: () => {},
  openAt: (_file: string, _line: number): Promise<void> | void => {},
  /** The host accepted a guest's text: guests may compile again. */
  resumed: () => {},
};

/** Shows whether the current document waits for the host to press Compile, and says so once. */
function refreshPause() {
  const by = current ? pausedBy(current.id, current.path, ed.getText(current.id)) : null;
  if (by !== null && latex.pausedBy === null) ui.toast(t("ai.collab.latex.hostPaused", { name: by }));
  latex.pausedBy = by;
}
onGuestChange(refreshPause);

/** The host's Compile: it accepts the text as it is now, and auto-compile goes on from there. */
export function compileNow() {
  if (!current) return;
  resumeCompiling(current.id, current.path, ed.getText(current.id));
  latex.guestInRun = false;
  remoteLatex.resumed();
  clearTimeout(timer);
  void run();
}
let remotePdf: Uint8Array | null = null;
/** The PDF of a guest's compile (`latex.pdf` is then only a marker). A copy: pdf.js takes it over. */
export const remotePdfBytes = () => (latex.pdf === "collab:pdf" && remotePdf ? remotePdf.slice() : null);
const isRemoteJob = (path: string | null) => !!path && path.startsWith("collab:");

/** The host's files changed: a guest's document may depend on them. */
export function recompileRemote() {
  if (!current || !isRemoteJob(current.path)) return;
  clearTimeout(timer);
  timer = window.setTimeout(run, 300);
}

let sync: SyncBox[] = [];
let timer: number | undefined;
let running = false;
let again = false;
let current: { id: string; path: string | null } | null = null;
let outlineTimer: number | undefined;

/** Installs Tectonic (into Omega's tools folder) and recompiles the current document. */
export async function installLatex() {
  if (!(await ensureTools(["tectonic"], t("tools.purpose.latex")))) return;
  await checkAvailable();
  if (current) schedule(current.id, current.path, 0);
}

export async function checkAvailable() {
  latex.available = await invoke<boolean>("latex_available");
  return latex.available;
}

/** Called whenever the active LaTeX buffer changes or becomes active. */
export function schedule(id: string, path: string | null, delay = 900, compile = true) {
  const switched = current?.id !== id;
  current = { id, path };
  refreshPause();
  if (switched) {
    latex.guestInRun = false;
    remoteLatex.cancel();
    latex.pdf = null;
    latex.diagnostics = [];
    latex.status = "idle";
    sync = [];
  }
  clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => (latex.outline = outline(ed.getText(id))), switched ? 0 : 300);
  if (!compile) return;
  clearTimeout(timer);
  timer = window.setTimeout(run, switched ? 0 : delay);
}

// Recompile when an included file (chapter, preamble, .bib, figure) changes on disk, e.g. edited in
// another tab, by git or by an external tool. The active buffer itself is already compiled on edit.
const DEPENDENCY = /\.(tex|bib|sty|cls|bst|png|jpe?g|pdf|eps|svg)$/i;
onFilesChanged((files) => {
  if (!current || !latex.available) return;
  if (!files.some((f) => f !== current!.path && DEPENDENCY.test(f))) return;
  clearTimeout(timer);
  timer = window.setTimeout(run, 300);
});

async function run() {
  if (!current) return;
  if (running) {
    again = true;
    return;
  }
  // A shared tab never compiles here: its text is the host's, and it could read this machine's files.
  const remote = isRemoteJob(current.path);
  if (remote && !remoteLatex.compile) return;
  if (remote) latex.available = true; // the host's Tectonic counts
  else {
    if (latex.available === null) await checkAvailable();
    if (!latex.available) return;
    // The one gate for keystrokes, file changes and tab switches. Nothing awaits from here to the
    // text being read, so an edit can't slip in between.
    if (!current || pausedBy(current.id, current.path, ed.getText(current.id)) !== null) return refreshPause();
  }
  running = true;
  latex.status = "compiling";
  latex.progress = null;
  const job = current;
  try {
    let bytes: Uint8Array | null = null;
    let r: CompileResult;
    if (remote) ({ result: r, bytes } = await remoteLatex.compile!(job.path!));
    else r = await invoke<CompileResult>("latex_compile", { path: job.path, content: ed.getText(job.id) });
    if (current?.id !== job.id) return;
    // TeX reads included files while it runs, so a guest's change from meanwhile may be in here.
    if (!remote && pausedBy(job.id, job.path, ed.getText(job.id)) !== null) latex.guestInRun = true;
    latex.millis = r.millis;
    latex.log = r.log;
    latex.diagnostics = r.diagnostics;
    latex.status = r.ok ? "ok" : "error";
    if (r.pdf && (r.ok || r.sync.length)) {
      remotePdf = bytes;
      latex.pdf = r.pdf;
      latex.pdfVersion++;
      sync = r.sync;
    }
    // The user may have left LaTeX mode (or switched tabs) while the compile ran.
    if (ed.isActive(job.id) && ed.activeMode() === "latex") applyDiagnostics(job.path);
  } catch (e) {
    latex.status = "error";
    latex.diagnostics = [{ file: "", line: 0, message: String(e), severity: "error" }];
  } finally {
    running = false;
    latex.progress = null;
    if (again) {
      again = false;
      run();
    }
  }
}

function applyDiagnostics(path: string | null) {
  const view = ed.getView();
  if (!view) return;
  const doc = view.state.doc;
  const diags: CmDiagnostic[] = latex.diagnostics
    .filter((d) => d.line > 0 && (!d.file || !path || d.file === path || d.file.endsWith("untitled.tex")))
    .filter((d) => d.line <= doc.lines)
    .map((d) => {
      const line = doc.line(d.line);
      return { from: line.from, to: line.to, severity: d.severity, message: d.message, source: "LaTeX" };
    });
  view.dispatch(setDiagnostics(view.state, diags));
}

export function setDark(v: boolean) {
  latex.dark = v;
  localStorage.setItem("pdfDark", String(v));
}

/** Editor line → PDF position. */
export function forwardSync(path: string | null, line: number) {
  const file = path ?? "";
  const candidates = sync.filter((b) => !path || b.file === file);
  if (!candidates.length) return false;
  // Closest record at or after the line, else the closest before it.
  let best = candidates[0];
  let bestScore = Infinity;
  for (const b of candidates) {
    const d = b.line >= line ? b.line - line : (line - b.line) * 4 + 0.5;
    if (d < bestScore) {
      bestScore = d;
      best = b;
    }
  }
  latex.target = { page: best.page, x: best.x, y: best.y, w: Math.max(best.w, 40), h: best.h, seq: Date.now() };
  return true;
}

/** PDF position (points, top-left origin) → source file + line. */
export function reverseSync(page: number, x: number, y: number): { file: string; line: number } | null {
  let best: SyncBox | null = null;
  let bestD = Infinity;
  for (const b of sync) {
    if (b.page !== page) continue;
    const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
    const dy = y < b.y ? b.y - y : y > b.y + b.h ? y - (b.y + b.h) : 0;
    // Vertical distance matters more: lines are wide, rows are tight.
    const d = dy * 3 + dx;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best ? { file: best.file, line: best.line } : null;
}
