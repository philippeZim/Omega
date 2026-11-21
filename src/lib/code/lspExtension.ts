/** CodeMirror integration for the LSP client: sync, completion, hover, diagnostics, definition, formatting. */
import type { Extension, Text } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type ViewUpdate } from "@codemirror/view";
import { viewActions } from "../editorActions";
import { autocompletion, insertCompletionText, snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { setDiagnostics, forEachDiagnostic, type Diagnostic, type Action } from "@codemirror/lint";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";
import { clientFor, fileUri, lspState, realPathOf, registerShadow, restartListeners, restartServer, setLspRoute, setLspWorkspace, uriPath, type LspClient, type ServerKind } from "./lsp.svelte";
import type { LangInfo } from "./languages";
import { isForeignLang } from "./langOverride.svelte";
import { clangdCommand, shadowForLsp } from "./langRun";
import { runsAlone } from "./projects";
import { dirname } from "../api";

// ---------------------------------------------------------- app hooks

let hooks = {
  workspace: () => null as string | null,
  askInstall: async (_k: ServerKind, _name: string) => false,
  navigate: async (_path: string, _line: number, _ch: number) => {},
};
export function setLspHooks(h: typeof hooks) {
  hooks = h;
  setLspWorkspace(h.workspace);
}

/** Restarts the language server of this file with the app's hooks (status indicator). */
export function restartLanguageServer(lang: LangInfo, path: string) {
  return restartServer(lang, path, hooks.workspace(), hooks.askInstall);
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

export function renderDoc(content: any): HTMLElement | null {
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

/** Whether the quote at `at` opens a string, going by the unescaped quotes before it on its line. */
function opensString(doc: Text, at: number, quote: string) {
  const line = doc.lineAt(at);
  const before = doc.sliceString(line.from, at).replace(/\\./g, "");
  return before.split(quote).length % 2 === 1;
}

/** Widens a range so a quoted completion takes the place of the quotes already typed or auto-closed. */
function coverQuotes(doc: Text, text: string, start: number, end: number, cursor: number): [number, number] {
  const quote = text[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return [start, end];
  if (start > 0 && doc.sliceString(start - 1, start) === quote && opensString(doc, start - 1, quote)) start--;
  const closes = text.length > 1 && text.endsWith(quote) && end === cursor && start < end && doc.sliceString(start, start + 1) === quote;
  if (closes && doc.sliceString(end, end + 1) === quote) end++;
  return [start, end];
}

/** `requestPos`: the cursor when the server was asked; its range ends move with what was typed since. */
export function applyItem(view: EditorView, item: any, from: number, to: number, requestPos = to) {
  const doc = view.state.doc;
  let start = from;
  let end = to;
  const edit = item.textEdit;
  if (edit) {
    const range = edit.range ?? edit.insert;
    start = toOffset(doc, range.start);
    end = Math.min(doc.length, Math.max(to, toOffset(doc, range.end) + to - requestPos));
  }
  const text: string = edit?.newText ?? item.insertText ?? item.label;
  [start, end] = coverQuotes(doc, text, start, end, to);
  const extra = (item.additionalTextEdits ?? []).map((e: any) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText }));
  if (extra.length) {
    view.dispatch({ changes: extra });
    // Recompute positions after the additional edits (they are usually above the cursor).
    const delta = extra.reduce((d: number, e: any) => (e.from <= start ? d + e.insert.length - (e.to - e.from) : d), 0);
    start += delta;
    end += delta;
  }
  if (item.insertTextFormat === 2) snippet(toCmSnippet(text))(view, { label: item.label }, start, end);
  else view.dispatch(insertCompletionText(view.state, text, start, end));
}

/** Completion entries for LSP items in their final order; `resolve` fills in the details on demand. */
export function completionOptions(items: any[], total: number, resolve: (item: any) => Promise<any>, requestPos?: number): Completion[] {
  return items.map((item, i) => {
    const label = String(item.filterText ?? item.label).trim();
    return {
      label,
      displayLabel: String(item.label).trim(),
      detail: item.labelDetails?.detail ?? item.detail?.split("\n")[0]?.slice(0, 60),
      type: KIND[item.kind] ?? "text",
      boost: total > 1 ? Math.round(99 - (i / (total - 1)) * 198) : 0,
      info: async () => {
        const full = await resolve(item);
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
      apply: (view, _c, from, to) => applyItem(view, item, from, to, requestPos),
    };
  });
}

function completionSource(getClient: () => LspClient | null, getUri: () => string, flush: () => void) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const client = getClient();
    if (!client) return null;
    const uri = getUri();
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
    const options = completionOptions(sorted.slice(0, 300), sorted.length, async (item) => {
      if (item.documentation || !client.capabilities.completionProvider?.resolveProvider) return item;
      const full = await client.request("completionItem/resolve", item).catch(() => item);
      if (full.additionalTextEdits) item.additionalTextEdits = full.additionalTextEdits;
      return full;
    }, ctx.pos);
    return {
      from: word ? word.from : ctx.pos,
      options,
      validFor: res.isIncomplete ? undefined : /^[\w$]*$/,
      filter: true,
    };
  };
}

// ---------------------------------------------------------- shared with the Code Together guest

/** The text edits of a WorkspaceEdit that target this document. */
export function editsForDoc(edit: any, uri: string): any[] {
  const mine = (u: string) => uriPath(u) === uriPath(uri);
  return [
    ...Object.entries(edit?.changes ?? {}).flatMap(([u, es]) => (mine(u) ? (es as any[]) : [])),
    ...(edit?.documentChanges ?? []).flatMap((c: any) => (c.textDocument && mine(c.textDocument.uri) ? c.edits : [])),
  ];
}

/** Quick fixes for one diagnostic: inline (clangd) or via textDocument/codeAction. */
export async function quickFixesFor(client: LspClient | null, uri: string, d: any): Promise<any[]> {
  let acts: any[] | null = d.codeActions ?? null;
  if (!acts && client?.capabilities.codeActionProvider && (d.severity ?? 1) <= 2) {
    acts = await client
      .request("textDocument/codeAction", { textDocument: { uri }, range: d.range, context: { diagnostics: [d], only: ["quickfix"] } }, 5000)
      .catch(() => null);
  }
  // Only actions that carry an edit (command-only actions would need workspace/applyEdit).
  return (acts ?? []).filter((a: any) => a?.edit && (!a.kind || String(a.kind).startsWith("quickfix")));
}

/** Diagnostics per document that get their quick fixes looked up. */
export const MAX_FIXES = 30;

export const severityName = (s: number | undefined): Diagnostic["severity"] => (s === 1 ? "error" : s === 2 ? "warning" : s === 3 ? "info" : "hint");

/** Ctrl+. – apply the quick fix at the cursor (menu when there are several). */
export function quickFixAtCursor(view: EditorView) {
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
}

export const lspTheme = EditorView.baseTheme({
  ".lsp-doc": { padding: "8px 12px", maxWidth: "560px", maxHeight: "320px", overflow: "auto", fontFamily: "var(--font)", fontSize: "12.5px", lineHeight: "1.5", color: "var(--label-2)" },
  ".lsp-doc pre, .lsp-detail": { fontFamily: "var(--mono)", fontSize: "12px", color: "var(--label)", whiteSpace: "pre-wrap", margin: "4px 0" },
  ".lsp-detail": { padding: "8px 12px 0" },
  ".lsp-doc code": { fontFamily: "var(--mono)", fontSize: "0.92em", color: "var(--label)" },
  ".cm-completionIcon": { opacity: "0.8", width: "1.2em" },
});

// ---------------------------------------------------------- extension

/** Delay before an editor reconnects to a restarted language server. */
const RECONNECT_MS = 1000;

export function lspExtension(path: string, lang: LangInfo): Extension {
  // A file set to another language is served through a private copy with the right extension.
  let uri = fileUri(path);
  let client: LspClient | null = null;
  let viewRef: EditorView | null = null;
  let changeTimer: number | undefined;
  /**
   * The tab was closed. With no other tab the editor keeps this state, so without this check a
   * stopped private server would be started again for a file nobody has open.
   */
  const closed = () => isForeignLang(path) && !(path in lspState.routes);
  /** Counts connection attempts: a slower older one must not attach after a newer one. */
  let connects = 0;

  const flush = () => {
    clearTimeout(changeTimer);
    if (client && viewRef) client.change(uri, viewRef.state.doc.toString());
  };

  /** Applies the parts of a WorkspaceEdit that target this document. */
  const applyEdit = (view: EditorView, edit: any) => {
    const edits = editsForDoc(edit, uri);
    if (!edits.length) return;
    const doc = view.state.doc;
    view.dispatch({ changes: edits.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })), userEvent: "input.quickfix" });
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
          severity: severityName(d.severity),
          message: d.message,
          source: d.source,
          ...(actions.length ? { actions } : {}),
        } as Diagnostic;
      });
    };
    // Show diagnostics right away; fixes are added when they arrive (if nothing changed meanwhile).
    view.dispatch(setDiagnostics(view.state, build(null)));
    const docAt = view.state.doc;
    const fixes = await Promise.all(raw.map((d, i) => (i < MAX_FIXES ? quickFixesFor(client, uri, d) : Promise.resolve([]))));
    if (my !== diagSeq || viewRef !== view || view.state.doc !== docAt || !fixes.some((f) => f.length)) return;
    view.dispatch(setDiagnostics(view.state, build(fixes)));
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
        if (this.retries-- > 0) setTimeout(() => viewRef === view && !client && !closed() && this.connect(view), RECONNECT_MS);
      };
      /** After a manual restart: editors without a client (failed or missing server) try again. */
      onRestart = () => {
        this.retries = 3;
        if (!client && viewRef && !closed()) this.connect(viewRef);
      };
      constructor(view: EditorView) {
        viewRef = view;
        restartListeners.add(this.onRestart);
        this.connect(view);
      }
      connect(view: EditorView) {
        if (!isForeignLang(path)) return this.attach(view, path);
        const mine = ++connects;
        const live = () => viewRef === view && mine === connects;
        setLspRoute(path, "pending");
        (async () => {
          if (!(await runsAlone(path, hooks.workspace()))) {
            if (!live()) return;
            setLspRoute(path, "project");
            return this.attach(view, path);
          }
          const { copy, root } = await shadowForLsp(path, lang);
          if (!live()) return; // the language changed or the tab closed meanwhile
          registerShadow(path, copy, root);
          uri = fileUri(copy);
          this.attach(view, copy);
        })().catch(() => {
          if (live()) setLspRoute(path, "none"); // unreadable: highlighting still works
        });
      }
      attach(view: EditorView, file: string) {
        clientFor(lang, file, hooks.workspace(), hooks.askInstall).then((c) => {
          if (!c || viewRef !== view) return;
          client = c;
          // A real file in a C/C++ project: clangd would otherwise guess from the missing extension.
          if (file === path && lang.server === "clangd" && isForeignLang(path))
            c.notify("workspace/didChangeConfiguration", { settings: { compilationDatabaseChanges: { [path]: { workingDirectory: dirname(path), compilationCommand: clangdCommand(lang.id, path) } } } });
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
        restartListeners.delete(this.onRestart);
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
    await hooks.navigate(realPathOf(uriPath(target)), range.start.line, range.start.character);
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
    autocompletion({ override: [completionSource(() => client, () => uri, flush)], icons: true, activateOnTypingDelay: 60 }),
    hover,
    viewActions.of({
      "lsp.gotoDefinition": (v) => (gotoDefinition(v), true),
      "lsp.format": (v) => (format(v), true),
      "lsp.quickFix": quickFixAtCursor,
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
    lspTheme,
  ];
}

/** Notify servers about saves (some re-run checks on save, e.g. rust-analyzer). */
export { fileUri };
