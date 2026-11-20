/** CodeMirror integration for the LSP client: sync, completion, hover, diagnostics, definition, formatting. */
import type { Extension, Text } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type ViewUpdate } from "@codemirror/view";
import { viewActions } from "../editorActions";
import { autocompletion, insertCompletionText, snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { setDiagnostics, forEachDiagnostic, type Diagnostic, type Action } from "@codemirror/lint";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";
import { clientFor, fileUri, uriPath, type LspClient, type ServerKind } from "./lsp.svelte";
import type { LangInfo } from "./languages";

// ---------------------------------------------------------- app hooks

let hooks = {
  workspace: () => null as string | null,
  askInstall: async (_k: ServerKind, _name: string) => false,
  navigate: async (_path: string, _line: number, _ch: number) => {},
};
export function setLspHooks(h: typeof hooks) {
  hooks = h;
}

// ---------------------------------------------------------- positions

export const toPos = (doc: Text, offset: number) => {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
};
export const toOffset = (doc: Text, p: { line: number; character: number }) => {
  if (p.line >= doc.lines) return doc.length;
  const line = doc.line(p.line + 1);
  return Math.min(line.to, line.from + p.character);
};

// ---------------------------------------------------------- markdown for docs/hover

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderDoc(content: any): HTMLElement | null {
  let md = "";
  if (!content) return null;
  if (typeof content === "string") md = content;
  else if (Array.isArray(content)) md = content.map((c) => (typeof c === "string" ? c : "```\n" + c.value + "\n```")).join("\n\n");
  else if (content.kind === "markdown" || content.kind === "plaintext") md = content.kind === "plaintext" ? esc(content.value) : content.value;
  else if (content.value) md = "```\n" + content.value + "\n```";
  md = md.trim();
  if (!md) return null;
  const el = document.createElement("div");
  el.className = "lsp-doc";
  const parts = md.split(/```[\w-]*\n?/);
  el.innerHTML = parts
    .map((p, i) =>
      i % 2
        ? `<pre>${esc(p.replace(/\n$/, ""))}</pre>`
        : esc(p)
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
            .replace(/\n{2,}/g, "<br><br>")
            .replace(/\n/g, " ")
            .replace(/^\s*---\s*$/gm, "<hr>"),
    )
    .join("");
  return el;
}

// ---------------------------------------------------------- completion

const KIND: Record<number, string> = {
  2: "method", 3: "function", 4: "class", 5: "property", 6: "variable", 7: "class", 8: "interface", 9: "namespace",
  10: "property", 12: "constant", 13: "enum", 14: "keyword", 15: "text", 20: "enum", 21: "constant", 22: "class", 25: "type",
};

/** LSP snippet syntax ($1, ${1:x}) → CodeMirror snippet syntax (${1}, ${1:x}). */
const toCmSnippet = (s: string) => s.replace(/\$(\d+)/g, "${$1}").replace(/\$\{0\}/g, "${}");

export function applyItem(view: EditorView, item: any, from: number, to: number) {
  const doc = view.state.doc;
  let start = from;
  const edit = item.textEdit;
  if (edit) {
    const range = edit.range ?? edit.insert;
    start = toOffset(doc, range.start);
  }
  const text: string = edit?.newText ?? item.insertText ?? item.label;
  const extra = (item.additionalTextEdits ?? []).map((e: any) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText }));
  if (extra.length) {
    view.dispatch({ changes: extra });
    // Recompute positions after the additional edits (they are usually above the cursor).
    const delta = extra.reduce((d: number, e: any) => (e.from <= start ? d + e.insert.length - (e.to - e.from) : d), 0);
    start += delta;
    to += delta;
  }
  if (item.insertTextFormat === 2) snippet(toCmSnippet(text))(view, { label: item.label }, start, to);
  else view.dispatch(insertCompletionText(view.state, text, start, to));
}

function completionSource(getClient: () => LspClient | null, uri: string, flush: () => void) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const client = getClient();
    if (!client) return null;
    const word = ctx.matchBefore(/[\w$]*/);
    const triggers: string[] = client.capabilities.completionProvider?.triggerCharacters ?? [".", ":", ">"];
    const charBefore = ctx.state.sliceDoc(ctx.pos - 1, ctx.pos);
    const triggered = triggers.includes(charBefore);
    if (!ctx.explicit && !triggered && (!word || word.from === word.to)) return null;
    flush();
    let res: any;
    try {
      res = await client.request("textDocument/completion", {
        textDocument: { uri },
        position: toPos(ctx.state.doc, ctx.pos),
        context: triggered && word?.from === word?.to ? { triggerKind: 2, triggerCharacter: charBefore } : { triggerKind: ctx.explicit ? 1 : 3 },
      });
    } catch {
      return null;
    }
    if (ctx.aborted || !res) return null;
    const items: any[] = Array.isArray(res) ? res : res.items ?? [];
    const sorted = [...items].sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
    const n = sorted.length;
    const options: Completion[] = sorted.slice(0, 300).map((item, i) => {
      const label = String(item.filterText ?? item.label).trim();
      return {
        label,
        displayLabel: String(item.label).trim(),
        detail: item.labelDetails?.detail ?? item.detail?.split("\n")[0]?.slice(0, 60),
        type: KIND[item.kind] ?? "text",
        boost: n > 1 ? Math.round(99 - (i / (n - 1)) * 198) : 0,
        info: async () => {
          let full = item;
          if (!item.documentation && client.capabilities.completionProvider?.resolveProvider) {
            full = await client.request("completionItem/resolve", item).catch(() => item);
            if (full.additionalTextEdits) item.additionalTextEdits = full.additionalTextEdits;
          }
          const el = renderDoc(full.documentation);
          if (!el && !full.detail) return null;
          const wrap = document.createElement("div");
          if (full.detail) {
            const pre = document.createElement("pre");
            pre.className = "lsp-detail";
            pre.textContent = full.detail;
            wrap.appendChild(pre);
          }
          if (el) wrap.appendChild(el);
          return wrap;
        },
        apply: (view, _c, from, to) => applyItem(view, item, from, to),
      };
    });
    return {
      from: word ? word.from : ctx.pos,
      options,
      validFor: res.isIncomplete ? undefined : /^[\w$]*$/,
      filter: true,
    };
  };
}

// ---------------------------------------------------------- extension

/** Delay before an editor reconnects to a restarted language server. */
const RECONNECT_MS = 1000;

export function lspExtension(path: string, lang: LangInfo): Extension {
  const uri = fileUri(path);
  let client: LspClient | null = null;
  let viewRef: EditorView | null = null;
  let changeTimer: number | undefined;

  const flush = () => {
    clearTimeout(changeTimer);
    if (client && viewRef) client.change(uri, viewRef.state.doc.toString());
  };

  /** Applies the parts of a WorkspaceEdit that target this document. */
  const applyEdit = (view: EditorView, edit: any) => {
    const mine = (u: string) => uriPath(u) === uriPath(uri);
    const edits: any[] = [
      ...Object.entries(edit?.changes ?? {}).flatMap(([u, es]) => (mine(u) ? (es as any[]) : [])),
      ...(edit?.documentChanges ?? []).flatMap((c: any) => (c.textDocument && mine(c.textDocument.uri) ? c.edits : [])),
    ];
    if (!edits.length) return;
    const doc = view.state.doc;
    view.dispatch({ changes: edits.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })), userEvent: "input.quickfix" });
  };

  /** Quick fixes for one diagnostic: inline (clangd) or via textDocument/codeAction. */
  const fixesFor = async (d: any): Promise<any[]> => {
    let acts: any[] | null = d.codeActions ?? null;
    if (!acts && client?.capabilities.codeActionProvider && (d.severity ?? 1) <= 2) {
      acts = await client
        .request("textDocument/codeAction", { textDocument: { uri }, range: d.range, context: { diagnostics: [d], only: ["quickfix"] } }, 5000)
        .catch(() => null);
    }
    // Only actions that carry an edit (command-only actions would need workspace/applyEdit).
    return (acts ?? []).filter((a: any) => a?.edit && (!a.kind || String(a.kind).startsWith("quickfix")));
  };

  let diagSeq = 0;
  const applyDiags = async () => {
    if (!client || !viewRef) return;
    const view = viewRef;
    const my = ++diagSeq;
    const raw: any[] = client.diagnostics.get(uri) ?? [];
    const build = (fixes: any[][] | null) => {
      const doc = view.state.doc;
      return raw.map((d: any, i) => {
        let from = toOffset(doc, d.range.start), to = toOffset(doc, d.range.end);
        if (from === to) to = Math.min(doc.length, from + 1);
        const actions: Action[] = (fixes?.[i] ?? []).map((a: any) => ({ name: a.title, apply: (v: EditorView) => applyEdit(v, a.edit) }));
        return {
          from,
          to,
          severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : d.severity === 3 ? "info" : "hint",
          message: d.message,
          source: d.source,
          ...(actions.length ? { actions } : {}),
        } as Diagnostic;
      });
    };
    // Show diagnostics right away; fixes are added when they arrive (if nothing changed meanwhile).
    view.dispatch(setDiagnostics(view.state, build(null)));
    const docAt = view.state.doc;
    const fixes = await Promise.all(raw.map((d, i) => (i < 30 ? fixesFor(d) : Promise.resolve([]))));
    if (my !== diagSeq || viewRef !== view || view.state.doc !== docAt || !fixes.some((f) => f.length)) return;
    view.dispatch(setDiagnostics(view.state, build(fixes)));
  };

  /** Ctrl+. – apply the quick fix at the cursor (menu when there are several). */
  const quickFix = (view: EditorView) => {
    const pos = view.state.selection.main.head;
    const acts: Action[] = [];
    forEachDiagnostic(view.state, (d, from, to) => {
      if (pos >= from && pos <= to) for (const a of d.actions ?? []) acts.push({ ...a, apply: (v: EditorView) => a.apply(v, from, to) });
    });
    if (!acts.length) return ui.toast(t("code.qf.none")), true;
    if (acts.length === 1) return acts[0].apply(view, pos, pos), true;
    const c = view.coordsAtPos(pos);
    ui.openMenu(new MouseEvent("contextmenu", { clientX: c?.left ?? 200, clientY: (c?.bottom ?? 200) + 4 }), acts.map((a) => ({ label: a.name, action: () => a.apply(view, pos, pos) })));
    return true;
  };

  const plugin = ViewPlugin.fromClass(
    class {
      listener = (u: string) => u === uri && applyDiags();
      /** Reconnects left after a server exit (a crashing server is not restarted forever). */
      retries = 3;
      onExit = () => {
        const view = viewRef;
        client?.diagnosticListeners.delete(this.listener);
        client?.exitListeners.delete(this.onExit);
        client = null;
        if (!view) return;
        // The dead server's diagnostics are stale.
        view.dispatch(setDiagnostics(view.state, []));
        if (this.retries-- > 0) setTimeout(() => viewRef === view && !client && this.connect(view), RECONNECT_MS);
      };
      constructor(view: EditorView) {
        viewRef = view;
        this.connect(view);
      }
      connect(view: EditorView) {
        clientFor(lang, path, hooks.workspace(), hooks.askInstall).then((c) => {
          if (!c || viewRef !== view) return;
          client = c;
          c.open(uri, lang.lspId, view.state.doc.toString());
          c.diagnosticListeners.add(this.listener);
          c.exitListeners.add(this.onExit);
          applyDiags();
        });
      }
      update(u: ViewUpdate) {
        if (u.docChanged) {
          clearTimeout(changeTimer);
          changeTimer = window.setTimeout(flush, 250);
        }
      }
      destroy() {
        flush();
        client?.diagnosticListeners.delete(this.listener);
        client?.exitListeners.delete(this.onExit);
        viewRef = null;
      }
    },
  );

  const hover = hoverTooltip(async (view, pos) => {
    if (!client?.capabilities.hoverProvider) return null;
    flush();
    const res: any = await client.request("textDocument/hover", { textDocument: { uri }, position: toPos(view.state.doc, pos) }).catch(() => null);
    const el = res && renderDoc(res.contents);
    if (!el) return null;
    const range = res.range;
    return {
      pos: range ? toOffset(view.state.doc, range.start) : pos,
      end: range ? toOffset(view.state.doc, range.end) : pos,
      above: true,
      create: () => ({ dom: el }),
    };
  }, { hoverTime: 350 });

  async function gotoDefinition(view: EditorView, pos = view.state.selection.main.head) {
    if (!client) return false;
    flush();
    const res: any = await client.request("textDocument/definition", { textDocument: { uri }, position: toPos(view.state.doc, pos) }).catch(() => null);
    const loc = Array.isArray(res) ? res[0] : res;
    if (!loc) return false;
    const target = loc.targetUri ?? loc.uri;
    const range = loc.targetSelectionRange ?? loc.range;
    await hooks.navigate(uriPath(target), range.start.line, range.start.character);
    return true;
  }

  async function format(view: EditorView) {
    if (!client?.capabilities.documentFormattingProvider) return false;
    flush();
    const edits: any[] = await client.request("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 4, insertSpaces: true } }).catch(() => null);
    if (!edits?.length) return true;
    const doc = view.state.doc;
    view.dispatch({ changes: edits.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })) });
    return true;
  }

  return [
    plugin,
    autocompletion({ override: [completionSource(() => client, uri, flush)], icons: true, activateOnTypingDelay: 60 }),
    hover,
    viewActions.of({
      "lsp.gotoDefinition": (v) => (gotoDefinition(v), true),
      "lsp.format": (v) => (format(v), true),
      "lsp.quickFix": quickFix,
    }),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        e.preventDefault();
        gotoDefinition(view, pos);
        return true;
      },
    }),
    EditorView.baseTheme({
      ".lsp-doc": { padding: "8px 12px", maxWidth: "560px", maxHeight: "320px", overflow: "auto", fontFamily: "var(--font)", fontSize: "12.5px", lineHeight: "1.5", color: "var(--label-2)" },
      ".lsp-doc pre, .lsp-detail": { fontFamily: "var(--mono)", fontSize: "12px", color: "var(--label)", whiteSpace: "pre-wrap", margin: "4px 0" },
      ".lsp-detail": { padding: "8px 12px 0" },
      ".lsp-doc code": { fontFamily: "var(--mono)", fontSize: "0.92em", color: "var(--label)" },
      ".cm-completionIcon": { opacity: "0.8", width: "1.2em" },
    }),
  ];
}

/** Notify servers about saves (some re-run checks on save, e.g. rust-analyzer). */
export { fileUri };
