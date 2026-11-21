/** Code Together, guest side of language intelligence: the host's server, shown like a local one. */
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type ViewUpdate } from "@codemirror/view";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { setDiagnostics, type Action, type Diagnostic } from "@codemirror/lint";
import { collab } from "./collab.svelte";
import { blockedByCapability, guestCan } from "./guard";
import { call, isObj, rpcErrorText, subscribe } from "./rpc.svelte";
import { REMOTE, openRemote, sharedText } from "./share.svelte";
import { isDocEntry, stampOf, textHash, type LspDocEntry, type LspDocsPayload, type TextStamp, type WireDiagnostic, type WireEdit, type WireFix } from "./lspProtocol";
import type { LspTarget } from "./lspHost.svelte";
import { completionOptions, lspTheme, quickFixAtCursor, renderDoc, severityName, toOffset, toPos } from "../code/lspExtension";
import { remoteLsp } from "../code/remoteLsp";
import * as ed from "../editor";
import { viewActions } from "../editorActions";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

declare module "./rpc.svelte" {
  interface RpcTopics {
    "lsp.docs": LspDocsPayload;
  }
}

const errorText = (code: string) =>
  code === "stale" ? t("code.lsp.guestStale") : code === "no_server" ? t("code.lsp.guestNoServer") : code === "not_open" || code === "unavailable" ? t("ai.collab.fileUnavailable") : rpcErrorText(code);

const entries = new Map<string, LspDocEntry>();
const refreshers = new Set<() => void>();

/** The doc's text if it is exactly what the entry was computed for. */
function matches(rel: string, view: EditorView, e: { hash: string; len: number }) {
  const y = sharedText(rel);
  const len = y ? y.length : view.state.doc.length;
  return len === e.len && textHash(y ? y.toString() : view.state.doc.toString()) === e.hash;
}

/** The guest's text right now, as the host will compare it. */
const stamp = (rel: string, view: EditorView): TextStamp => stampOf(sharedText(rel)?.toString() ?? view.state.doc.toString());

/** Applies edits computed for `base`, through the editor and so the shared text and its undo. */
function applyEdits(rel: string, view: EditorView, base: TextStamp, edits: WireEdit[], userEvent: string) {
  if (!guestCan("edit")) return void blockedByCapability("edit");
  if (!matches(rel, view, base)) return ui.toast(t("code.lsp.guestStale"), "error");
  if (!edits.length) return;
  const doc = view.state.doc;
  view.dispatch({ changes: edits.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })), userEvent });
}

export function toDiagnostics(view: EditorView, list: WireDiagnostic[], rel = "", base?: TextStamp, fixes?: WireFix[][]): Diagnostic[] {
  const doc = view.state.doc;
  return list.map((d, i) => {
    const from = toOffset(doc, d.range.start);
    let to = toOffset(doc, d.range.end);
    if (from === to) to = Math.min(doc.length, from + 1);
    const actions: Action[] = base ? (fixes?.[i] ?? []).map((f) => ({ name: f.title, apply: (v: EditorView) => applyEdits(rel, v, base, f.edits, "input.quickfix") })) : [];
    return { from, to: Math.max(from, to), severity: severityName(d.severity), message: d.message, source: d.source, ...(actions.length ? { actions } : {}) };
  });
}

function guestPlugin(rel: string) {
  return ViewPlugin.fromClass(
    class {
      /** Revision on screen; 0: nothing from the host. */
      shown = 0;
      gone = false;
      timer: ReturnType<typeof setTimeout> | undefined;
      refresh = () => this.schedule();
      constructor(readonly view: EditorView) {
        refreshers.add(this.refresh);
        this.schedule();
      }
      /** Outside the update cycle, and after the Yjs binding took the change. */
      schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.sync(), 0);
      }
      sync() {
        const e = entries.get(rel);
        if (!e) {
          if (this.shown) this.view.dispatch(setDiagnostics(this.view.state, []));
          this.shown = 0;
          return;
        }
        // For another version of the text its positions would be wrong: keep what's shown (it
        // moves along with edits) until the entry for this text arrives.
        if (e.rev === this.shown || !matches(rel, this.view, e)) return;
        this.shown = e.rev;
        this.view.dispatch(setDiagnostics(this.view.state, toDiagnostics(this.view, e.diagnostics)));
        void this.addFixes(e);
      }
      /** Like on the host: the marks come right away, their quick fixes when they arrive. */
      async addFixes(e: LspDocEntry) {
        if (!e.diagnostics.length || !e.features.codeActions || !guestCan("edit")) return;
        const docAt = this.view.state.doc;
        const r = await call("lsp.fixes", { path: rel, rev: e.rev }, { timeoutMs: 8000 });
        if (!r.ok || !r.value || !isFixes(r.value.fixes) || this.shown !== e.rev || this.gone || this.view.state.doc !== docAt) return;
        const { base, fixes } = r.value;
        if (!fixes.some((f) => f.length)) return;
        this.view.dispatch(setDiagnostics(this.view.state, toDiagnostics(this.view, e.diagnostics, rel, base, fixes)));
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule();
      }
      destroy() {
        this.gone = true;
        clearTimeout(this.timer);
        refreshers.delete(this.refresh);
      }
    },
  );
}

const isEdit = (e: any): e is WireEdit => typeof e?.newText === "string" && Number.isSafeInteger(e?.range?.start?.line) && Number.isSafeInteger(e?.range?.start?.character) && Number.isSafeInteger(e?.range?.end?.line) && Number.isSafeInteger(e?.range?.end?.character);
const isFixes = (v: unknown): v is WireFix[][] => Array.isArray(v) && v.every((l) => Array.isArray(l) && l.every((f) => typeof f?.title === "string" && Array.isArray(f.edits) && f.edits.every(isEdit)));

function completionSource(rel: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    // Nothing could be inserted without `edit`.
    if (!guestCan("edit")) return null;
    const word = ctx.matchBefore(/[\w$]*/);
    const triggers = entries.get(rel)?.features.triggers ?? [".", ":", ">"];
    const charBefore = ctx.state.sliceDoc(ctx.pos - 1, ctx.pos);
    const triggered = triggers.includes(charBefore);
    if (!ctx.explicit && !triggered && (!word || word.from === word.to)) return null;
    const cancel = new AbortController();
    ctx.addEventListener("abort", () => cancel.abort(), { onDocChange: true });
    const at = stampOf(sharedText(rel)?.toString() ?? ctx.state.doc.toString());
    const r = await call(
      "lsp.completion",
      { path: rel, at, pos: toPos(ctx.state.doc, ctx.pos), explicit: ctx.explicit, ...(triggered && word?.from === word?.to ? { trigger: charBefore } : {}) },
      { signal: cancel.signal, timeoutMs: 8000 },
    );
    if (ctx.aborted || !r.ok || !Array.isArray(r.value?.items)) return null;
    const { list, total, incomplete, items } = r.value;
    const options = completionOptions(items, total, async (item) => {
      if (item.documentation || !entries.get(rel)?.features.resolve) return item;
      const full = await call("lsp.resolve", { path: rel, list, id: item.id }, { timeoutMs: 5000 });
      if (!full.ok || !full.value) return item;
      if (full.value.additionalTextEdits) item.additionalTextEdits = full.value.additionalTextEdits;
      return { ...item, ...full.value };
    });
    return { from: word ? word.from : ctx.pos, options, validFor: incomplete ? undefined : /^[\w$]*$/, filter: true };
  };
}

/** Opens a shared file at a position; a tab that's already open also gets the cursor there. */
async function gotoRemote(rel: string, line: number, character: number) {
  const wasOpen = !!sharedText(rel);
  await openRemote(rel, line + 1);
  if (!wasOpen) return;
  const view = ed.getView();
  if (!view) return;
  const l = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
  view.dispatch({ selection: { anchor: Math.min(l.to, l.from + character) }, scrollIntoView: true });
  view.focus();
}

async function gotoDefinition(rel: string, view: EditorView, pos = view.state.selection.main.head) {
  const r = await call("lsp.definition", { path: rel, at: stamp(rel, view), pos: toPos(view.state.doc, pos) });
  if (!r.ok) return ui.toast(errorText(r.error.code), "error");
  const target: LspTarget | null = r.value;
  if (!target) return;
  if ("outside" in target) return ui.toast(t("code.lsp.guestOutside", { name: String(target.outside) }));
  if (typeof target.path === "string") await gotoRemote(target.path, target.line, target.character);
}

async function format(rel: string, view: EditorView) {
  if (blockedByCapability("edit")) return;
  const r = await call("lsp.format", { path: rel, at: stamp(rel, view) });
  if (!r.ok) return r.error.code === "unsupported" ? undefined : ui.toast(errorText(r.error.code), "error");
  if (Array.isArray(r.value?.edits) && r.value.edits.every(isEdit)) applyEdits(rel, view, r.value.base, r.value.edits, "input.format");
}

export function guestLspExtension(rel: string): Extension {
  const hover = hoverTooltip(async (view, pos) => {
    if (entries.get(rel)?.features.hover === false) return null;
    const r = await call("lsp.hover", { path: rel, at: stamp(rel, view), pos: toPos(view.state.doc, pos) }, { timeoutMs: 6000 });
    if (!r.ok || !r.value) return null;
    const el = renderDoc(r.value.contents);
    if (!el) return null;
    const range = r.value.range;
    return {
      pos: range ? toOffset(view.state.doc, range.start) : pos,
      end: range ? toOffset(view.state.doc, range.end) : pos,
      above: true,
      create: () => ({ dom: el }),
    };
  }, { hoverTime: 350 });

  return [
    guestPlugin(rel),
    autocompletion({ override: [completionSource(rel)], icons: true, activateOnTypingDelay: 60 }),
    hover,
    viewActions.of({
      "lsp.gotoDefinition": (v) => (void gotoDefinition(rel, v), true),
      "lsp.format": (v) => (void format(rel, v), true),
      "lsp.quickFix": quickFixAtCursor,
    }),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        e.preventDefault();
        void gotoDefinition(rel, view, pos);
        return true;
      },
    }),
    lspTheme,
  ];
}

remoteLsp.extension = guestLspExtension;
remoteLsp.openAt = (path, line, col) => gotoRemote(path.slice(REMOTE.length), line - 1, col - 1);
remoteLsp.symbols = async (query) => {
  if (collab.role !== "guest") return null;
  const r = await call("lsp.symbols", { query }, { timeoutMs: 6000 });
  if (!r.ok || !Array.isArray(r.value)) return [];
  return r.value.filter((s) => typeof s?.path === "string" && typeof s.name === "string").map((s) => ({ ...s, path: REMOTE + s.path }));
};

/** Applies a message of the `lsp.docs` topic. Anything malformed is ignored. */
export function applyDocs(payload: unknown) {
  if (payload === null) entries.clear();
  else if (isObj(payload) && isObj(payload.docs)) {
    if (payload.full === true) entries.clear();
    for (const [rel, e] of Object.entries(payload.docs)) {
      if (e === null) entries.delete(rel);
      else if (isDocEntry(e)) entries.set(rel, e);
    }
  } else return;
  for (const r of refreshers) r();
}

subscribe("lsp.docs", applyDocs);

export const guestEntry = (rel: string) => entries.get(rel) ?? null;

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
