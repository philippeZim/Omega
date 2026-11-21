/**
 * Code Together: LaTeX for guests compiles on the host, with the host's project and the current
 * shared text (latex_guest.rs). It needs `run`. Text from a guest without `run` compiles only after
 * the host pressed Compile (guestChanges.ts), also when another guest asks.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { call, hasCapability, isObj, onCapabilitiesChanged, publish, registerMethod, registerTopic, rpcErrorText, RpcFail, subscribe } from "./rpc.svelte";
import { collab } from "./collab.svelte";
import { applyingRemoteEdit, docEditListeners, guestScope, hostCompileTexts, openRemote } from "./share.svelte";
import { guestFile } from "./guestAssets";
import { guestChangeHooks, isPaused } from "./guestChanges";
import { applyProgress, recompileRemote, remoteLatex, type CompileResult, type LatexProgress } from "../latex/controller.svelte";
import { onFilesChanged } from "../fsWatch.svelte";
import { app, collabHooks } from "../state.svelte";
import { t } from "../i18n/index.svelte";

interface HostCompile extends Omit<CompileResult, "pdf"> {
  pdf: string | null;
}
type ProgressMsg = { nonce: string; phase: LatexProgress["phase"]; downloads: number; file: string | null };

declare module "./rpc.svelte" {
  interface RpcMethods {
    "latex.compile": { params: { key: string; nonce: string }; result: HostCompile };
  }
  interface RpcTopics {
    "latex.progress": ProgressMsg;
    "latex.changed": { gen: number; by: string | null };
  }
}

const CODE = /^[a-z][a-z0-9_]{0,40}$/;
const PHASES = ["format", "download", "tex", "rerun", "pdf", "write"];
/** The host's limit plus time for the answer. */
const COMPILE_TIMEOUT_MS = 185_000;
const BUSY_RETRY_MS = 1500;
const DEPENDENCY = /\.(tex|bib|sty|cls|bst|png|jpe?g|pdf|eps)$/i;

// ------------------------------------------------------------------ host

registerTopic({ name: "latex.progress", capability: "run" });
registerTopic({ name: "latex.changed", capability: "run" });

registerMethod({
  name: "latex.compile",
  capability: "run",
  validate: (raw) => (isObj(raw) && typeof raw.key === "string" && raw.key.length <= 4096 && typeof raw.nonce === "string" && /^[a-z0-9]{1,24}$/.test(raw.nonce) ? { key: raw.key, nonce: raw.nonce } : null),
  handle: async ({ key, nonce }, { peer, signal }) => {
    const texts = hostCompileTexts(key, peer);
    if (!texts) throw new RpcFail("latex_no_doc");
    const untitled = texts.key.startsWith("tab:");
    const scope = untitled ? null : guestScope();
    if (!untitled && (!scope || !(await scope.check(texts.key)))) throw new RpcFail("path_refused");
    const overlays: { rel: string; text: string }[] = [];
    if (scope) for (const o of texts.overlays) if (await scope.check(o.rel)) overlays.push(o);
    if (signal.aborted || (scope && !scope.live())) throw new RpcFail("cancelled");
    // After the last await: nothing a guest without `run` wrote compiles until the host says so.
    if (isPaused(scope?.root ?? null, untitled ? texts.key.slice(4) : null)) throw new RpcFail("latex_paused");
    const job = `${peer}:${nonce}`;
    jobs.set(job, nonce);
    const cancel = () => void invoke("latex_guest_cancel", { job }).catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await invoke<HostCompile>("latex_guest_compile", { job, root: scope?.root ?? null, file: untitled ? null : texts.key, content: texts.text, overlays });
    } catch (e) {
      throw new RpcFail(CODE.test(String(e)) ? String(e) : "compile_failed");
    } finally {
      signal.removeEventListener("abort", cancel);
      jobs.delete(job);
    }
  },
});

/** Running jobs: only their progress goes out. */
const jobs = new Map<string, string>();

listen<{ job: string; phase: LatexProgress["phase"]; downloads: number; file: string | null }>("latex-guest-progress", ({ payload: p }) => {
  const nonce = jobs.get(p.job);
  if (nonce) publish("latex.progress", { nonce, phase: p.phase, downloads: p.downloads, file: p.file });
});

guestChangeHooks.mayRun = (peer) => hasCapability(peer, "run");
guestChangeHooks.name = (peer) => collab.participants.find((p) => p.peer === peer)?.name || t("ai.collab.guest");
collabHooks.editBlocksCompile = applyingRemoteEdit;

let changedGen = 0;
let changedTimer: ReturnType<typeof setTimeout> | undefined;
function announceChange(by: string | null) {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(() => publish("latex.changed", { gen: ++changedGen, by }), 500);
}
onFilesChanged((files) => {
  if (collab.role === "host" && !isPaused(app.root, null) && files.some((f) => DEPENDENCY.test(f))) announceChange(null);
});
docEditListeners.add((peer) => {
  if (collab.role === "host" && !isPaused(app.root, null) && (!peer || hasCapability(peer, "run"))) announceChange(peer);
});
remoteLatex.resumed = () => {
  if (collab.role === "host") announceChange(null);
};

// ------------------------------------------------------------------ guest

/** Text for a compile refusal. */
export function compileErrorText(code: string): string {
  switch (code) {
    case "no_root":
      return t("ai.collab.latex.noRoot");
    case "tectonic_missing":
      return t("ai.collab.latex.noTectonic");
    case "root_outside":
    case "path_refused":
      return t("ai.collab.latex.rootOutside");
    case "project_too_large":
      return t("ai.collab.latex.projectTooLarge");
    case "output_too_large":
      return t("ai.collab.latex.outputTooLarge");
    case "compile_timeout":
      return t("ai.collab.latex.timeout");
    case "busy":
      return t("ai.collab.latex.busy");
    case "pdf_too_large":
      return t("ai.collab.latex.pdfTooLarge");
    case "latex_paused":
      return t("ai.collab.latex.paused");
    case "latex_no_doc":
      return t("ai.collab.latex.noDoc");
    default:
      return rpcErrorText(code);
  }
}

/** Host result → what the controller shows: guest tab paths, PDF as bytes. */
export function toGuestResult(r: HostCompile): { result: CompileResult; bytes: Uint8Array | null } {
  const bytes = r.pdf ? Uint8Array.from(atob(r.pdf), (c) => c.charCodeAt(0)) : null;
  return {
    bytes,
    result: {
      ...r,
      pdf: bytes ? "collab:pdf" : null,
      diagnostics: r.diagnostics.map((d) => ({ ...d, file: guestFile(d.file) })),
      sync: r.sync.map((b) => ({ ...b, file: guestFile(b.file) })),
    },
  };
}

let running: AbortController | null = null;
let currentNonce = "";

subscribe("latex.progress", (p) => {
  if (p && p.nonce === currentNonce && PHASES.includes(p.phase)) applyProgress({ phase: p.phase, downloads: Number(p.downloads) || 0, file: typeof p.file === "string" ? p.file : null });
});
subscribe("latex.changed", (p) => {
  // The guest's own edits have already scheduled a compile.
  if (p && p.by !== collab.myPeer) recompileRemote();
});

const refused = (code: string): { result: CompileResult; bytes: null } => ({
  bytes: null,
  result: { ok: false, pdf: null, diagnostics: [{ file: "", line: 0, message: compileErrorText(code), severity: "error" }], log: "", sync: [], millis: 0 },
});

remoteLatex.compile = async (path) => {
  const key = path.slice("collab:".length);
  const ctl = (running = new AbortController());
  currentNonce = Math.random().toString(36).slice(2, 14) || "n";
  try {
    for (;;) {
      const r = await call("latex.compile", { key, nonce: currentNonce }, { timeoutMs: COMPILE_TIMEOUT_MS, signal: ctl.signal });
      if (r.ok) return toGuestResult(r.value);
      if (r.error.code !== "busy" || ctl.signal.aborted) return refused(r.error.code);
      await new Promise((res) => setTimeout(res, BUSY_RETRY_MS));
      if (ctl.signal.aborted) return refused("cancelled");
    }
  } finally {
    if (running === ctl) running = null;
  }
};
remoteLatex.cancel = () => running?.abort();
// The range puts the cursor at the start of the line, as a jump does on the host.
remoteLatex.openAt = (file, line) => openRemote(file.slice("collab:".length), line, [0, 0]);

// `run` came back: the panel still shows the refusal.
onCapabilitiesChanged((before, now) => {
  if (now.includes("run") && !before.includes("run")) recompileRemote();
});
