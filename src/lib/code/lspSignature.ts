/** LSP signature help: a popup at the call being typed, with the active parameter marked. */
import { completionStatus } from "@codemirror/autocomplete";
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type ViewUpdate } from "@codemirror/view";
import type { LspClient } from "./lsp.svelte";

interface Shown {
  pos: number;
  help: any;
}

const setSignature = StateEffect.define<Shown | null>({
  map: (v, changes) => v && { ...v, pos: changes.mapPos(v.pos) },
});

/** Waits for a pause in typing before asking again. */
const REQUEST_MS = 60;

/** Where a parameter's name is in the signature label. */
export function paramRange(label: string, param: any): [number, number] | null {
  const name = param?.label;
  if (Array.isArray(name)) {
    const [from, to] = name;
    return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to && to <= label.length ? [from, to] : null;
  }
  if (typeof name !== "string" || !name) return null;
  // The first whole-word match after the opening bracket: `n` must not match inside `fn`.
  for (let at = label.indexOf(name, label.indexOf("(") + 1); at >= 0; at = label.indexOf(name, at + 1)) {
    const end = at + name.length;
    if (!/\w/.test(label[at - 1] ?? "") && !/\w/.test(label[end] ?? "")) return [at, end];
  }
  return null;
}

/** The signature to show and the index of its active parameter (-1: none). */
export function activeSignature(help: any): { sig: any; index: number; number: number } | null {
  const all: any[] = Array.isArray(help?.signatures) ? help.signatures : [];
  if (!all.length) return null;
  const wanted = help.activeSignature ?? 0;
  const number = Number.isInteger(wanted) && wanted >= 0 && wanted < all.length ? wanted : 0;
  const sig = all[number];
  const params: any[] = Array.isArray(sig.parameters) ? sig.parameters : [];
  const active = sig.activeParameter !== undefined ? sig.activeParameter : help.activeParameter ?? 0;
  if (active === null || !params.length) return { sig, index: -1, number };
  // The protocol: a value out of range counts as the first parameter.
  return { sig, index: Number.isInteger(active) && active >= 0 && active < params.length ? active : 0, number };
}

/** The popup. Server text only ever goes in as text; docs go through the hover renderer. */
export function renderSignature(help: any, renderDoc: (content: any) => HTMLElement | null): HTMLElement {
  const el = document.createElement("div");
  el.className = "lsp-signature";
  const shown = activeSignature(help);
  if (!shown) return el;
  const { sig, index, number } = shown;
  const label = String(sig.label ?? "");
  const line = document.createElement("div");
  line.className = "lsp-signature-label";
  const total = help.signatures.length;
  if (total > 1) {
    const count = document.createElement("span");
    count.className = "lsp-signature-count";
    count.textContent = `${number + 1}/${total}`;
    line.appendChild(count);
  }
  const param = index >= 0 ? sig.parameters[index] : null;
  const range = param ? paramRange(label, param) : null;
  if (range) {
    const active = document.createElement("span");
    active.className = "lsp-signature-active";
    active.textContent = label.slice(range[0], range[1]);
    line.append(label.slice(0, range[0]), active, label.slice(range[1]));
  } else {
    line.append(label);
  }
  el.appendChild(line);
  for (const doc of [param?.documentation, sig.documentation]) {
    const rendered = doc ? renderDoc(doc) : null;
    if (rendered) el.appendChild(rendered);
  }
  return el;
}

const theme = EditorView.baseTheme({
  ".lsp-signature": { maxWidth: "560px" },
  ".lsp-signature-label": { padding: "6px 12px", fontFamily: "var(--mono)", fontSize: "12.5px", color: "var(--label-2)", whiteSpace: "pre-wrap" },
  ".lsp-signature-active": { color: "var(--label)", fontWeight: "700", textDecoration: "underline" },
  ".lsp-signature-count": { marginRight: "8px", color: "var(--label-3)" },
});

export function signatureHelp(getClient: () => LspClient | null, getUri: () => string, flush: () => void, renderDoc: (content: any) => HTMLElement | null): Extension {
  const field = StateField.define<Shown | null>({
    create: () => null,
    update(value, tr) {
      let next = value && tr.docChanged ? { ...value, pos: tr.changes.mapPos(value.pos) } : value;
      for (const e of tr.effects) if (e.is(setSignature)) next = e.value;
      return next;
    },
    provide: (f) =>
      showTooltip.from(f, (v) =>
        v ? { pos: v.pos, above: true, create: () => ({ dom: renderSignature(v.help, renderDoc) }) } : null,
      ),
  });

  const plugin = ViewPlugin.fromClass(
    class {
      timer: number | undefined;
      /** Identifies the latest request: an older answer is dropped. */
      seq = 0;
      /** A request is planned or under way. */
      pending = false;
      destroyed = false;
      constructor(readonly view: EditorView) {}

      cancel() {
        clearTimeout(this.timer);
        this.seq++;
        this.pending = false;
      }
      close() {
        this.cancel();
        // A view update can't dispatch; this runs right after it.
        queueMicrotask(() => {
          if (!this.destroyed && this.view.state.field(field)) this.view.dispatch({ effects: setSignature.of(null) });
        });
      }
      schedule(kind: 2 | 3, char?: string) {
        this.cancel();
        this.pending = true;
        const my = this.seq;
        this.timer = window.setTimeout(() => void this.request(my, kind, char), REQUEST_MS);
      }
      async request(my: number, kind: 2 | 3, char?: string) {
        const client = getClient();
        if (!client?.capabilities.signatureHelpProvider) return void (this.pending = false);
        flush();
        const { state } = this.view;
        const head = state.selection.main.head;
        const line = state.doc.lineAt(head);
        const open = state.field(field);
        const res: any = await client
          .request(
            "textDocument/signatureHelp",
            {
              textDocument: { uri: getUri() },
              position: { line: line.number - 1, character: head - line.from },
              context: { triggerKind: kind, ...(char ? { triggerCharacter: char } : {}), isRetrigger: !!open, ...(open ? { activeSignatureHelp: open.help } : {}) },
            },
            5000,
          )
          .catch(() => null);
        if (my !== this.seq || this.destroyed) return;
        this.pending = false;
        const now = this.view.state;
        if (now.doc !== state.doc || now.selection.main.head !== head) return;
        const current = now.field(field);
        if (activeSignature(res)) this.view.dispatch({ effects: setSignature.of({ pos: current?.pos ?? head, help: res }) });
        else if (current) this.view.dispatch({ effects: setSignature.of(null) });
      }
      update(u: ViewUpdate) {
        if (u.transactions.some((tr) => tr.effects.some((e) => e.is(setSignature) && e.value === null))) this.cancel();
        if (u.focusChanged && !u.view.hasFocus) return this.close();
        if (!u.docChanged && !u.selectionSet) return;
        const open = u.state.field(field);
        const sel = u.state.selection.main;
        if (!sel.empty) return open || this.pending ? this.close() : undefined;
        const triggers: string[] = getClient()?.capabilities.signatureHelpProvider?.triggerCharacters ?? [];
        const char = u.state.sliceDoc(sel.head - 1, sel.head);
        if (u.transactions.some((tr) => tr.isUserEvent("input.type")) && triggers.includes(char)) this.schedule(2, char);
        else if (open || this.pending) this.schedule(3);
      }
      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
      }
    },
  );

  const escape = (view: EditorView) => {
    // An open completion list takes the first Escape.
    if (completionStatus(view.state) === "active") return false;
    const p = view.plugin(plugin);
    if (!view.state.field(field)) {
      p?.cancel();
      return false;
    }
    p?.cancel();
    view.dispatch({ effects: setSignature.of(null) });
    return true;
  };

  return [field, plugin, Prec.highest(keymap.of([{ key: "Escape", run: escape }])), theme];
}
