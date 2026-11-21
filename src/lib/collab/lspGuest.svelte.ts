/** Code Together, guest side of language intelligence: the host's server, shown like a local one. */
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { isObj, subscribe } from "./rpc.svelte";
import { sharedText } from "./share.svelte";
import { isDocEntry, textHash, type LspDocEntry, type LspDocsPayload, type WireDiagnostic } from "./lspProtocol";
import { lspTheme, severityName, toOffset } from "../code/lspExtension";
import { remoteLsp } from "../code/remoteLsp";

declare module "./rpc.svelte" {
  interface RpcTopics {
    "lsp.docs": LspDocsPayload;
  }
}

const entries = new Map<string, LspDocEntry>();
const refreshers = new Set<() => void>();

/** The doc's text if it is exactly what the entry was computed for. */
function matches(rel: string, view: EditorView, e: { hash: string; len: number }) {
  const y = sharedText(rel);
  const len = y ? y.length : view.state.doc.length;
  return len === e.len && textHash(y ? y.toString() : view.state.doc.toString()) === e.hash;
}

export function toDiagnostics(view: EditorView, list: WireDiagnostic[]): Diagnostic[] {
  const doc = view.state.doc;
  return list.map((d) => {
    const from = toOffset(doc, d.range.start);
    let to = toOffset(doc, d.range.end);
    if (from === to) to = Math.min(doc.length, from + 1);
    return { from, to: Math.max(from, to), severity: severityName(d.severity), message: d.message, source: d.source };
  });
}

function guestPlugin(rel: string) {
  return ViewPlugin.fromClass(
    class {
      /** Revision on screen; 0: nothing from the host. */
      shown = 0;
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
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule();
      }
      destroy() {
        clearTimeout(this.timer);
        refreshers.delete(this.refresh);
      }
    },
  );
}

export function guestLspExtension(rel: string): Extension {
  return [guestPlugin(rel), lspTheme];
}

remoteLsp.extension = guestLspExtension;

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
