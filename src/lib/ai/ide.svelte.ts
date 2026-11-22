/**
 * Claude Code IDE integration (frontend half of ide_ws.rs): implements the tools the CLI calls
 * (openFile, openDiff, getDiagnostics, selections, editors …) and sends selection_changed /
 * at_mentioned notifications, so `claude` in our terminal knows what you're looking at.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "../windowEvents";
import { EditorView } from "@codemirror/view";
import { app, activeTab, openFile, save, syncFromDisk } from "../state.svelte";
import * as ed from "../editor";
import { allClients, fileUri, uriPath } from "../code/lsp.svelte";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

import { newTerminalWith, terms, focusTerm } from "../terminal.svelte";
import { showView } from "../layout.svelte";
import { basename } from "../api";


type Args = Record<string, any>;
const text = (t: string) => ({ content: [{ type: "text", text: t }] });
const jsonText = (v: unknown) => text(JSON.stringify(v));

interface Sel {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: { start: { line: number; character: number }; end: { line: number; character: number }; isEmpty: boolean };
}

/** Current selection of the active editor in protocol form (0-based lines/characters). */
function currentSelection(): Sel | null {
  const v = ed.getView();
  const t = activeTab();
  if (!v || !t?.path || t.path.startsWith("collab:")) return null;
  const s = v.state.selection.main;
  const pos = (p: number) => {
    const l = v.state.doc.lineAt(p);
    return { line: l.number - 1, character: p - l.from };
  };
  return {
    text: v.state.sliceDoc(s.from, s.to),
    filePath: t.path,
    fileUrl: fileUri(t.path),
    selection: { start: pos(s.from), end: pos(s.to), isEmpty: s.empty },
  };
}

let latest: Sel | null = null;

function languageId(path: string) {
  const ext = path.split(".").pop() ?? "";
  return ({ py: "python", ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact", rs: "rust", scala: "scala", sc: "scala", ml: "ocaml", mli: "ocaml.interface", mojo: "mojo", "🔥": "mojo", go: "go", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", java: "java", md: "markdown", tex: "latex", json: "json", toml: "toml", html: "html", css: "css", sh: "shellscript" } as Record<string, string>)[ext] ?? "plaintext";
}

const findTab = (p: string) => app.tabs.find((t) => t.path === p);

/** Pending openDiff calls: resolved when Claude closes the tab (the user answered in the terminal). */
const diffs = new Map<string, { call: number; path: string }>();

function finishDiff(name: string) {
  const d = diffs.get(name);
  if (!d) return;
  diffs.delete(name);
  invoke("ide_reply", { call: d.call, result: { content: [{ type: "text", text: "DIFF_REJECTED" }, { type: "text", text: name }] } });
  // Claude writes the file itself → pick up the new content shortly after.
  for (const ms of [150, 600, 1500]) setTimeout(() => syncFromDisk(), ms);
}

const SEVERITY = ["", "Error", "Warning", "Info", "Hint"];

const TOOLS: { name: string; description: string; inputSchema: object; run: (a: Args, call: number) => unknown }[] = [
  {
    name: "openFile",
    description: "Open a file in the editor and optionally select a range of text",
    inputSchema: { type: "object", properties: { filePath: { type: "string" }, preview: { type: "boolean" }, startText: { type: "string" }, endText: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" }, selectToEndOfLine: { type: "boolean" }, makeFrontmost: { type: "boolean" } }, required: ["filePath"] },
    run: async (a) => {
      await openFile(a.filePath, false, !!(a.startText || a.startLine));
      const v = ed.getView();
      if (v) {
        const doc = v.state.doc;
        let from = -1, to = -1;
        if (a.startText) {
          from = doc.toString().indexOf(a.startText);
          if (from >= 0) {
            to = from + a.startText.length;
            if (a.endText) {
              const e = doc.toString().indexOf(a.endText, to);
              if (e >= 0) to = e + a.endText.length;
            }
            if (a.selectToEndOfLine) to = doc.lineAt(to).to;
          }
        } else if (a.startLine) {
          from = doc.line(Math.min(a.startLine, doc.lines)).from;
          to = doc.line(Math.min(a.endLine ?? a.startLine, doc.lines)).to;
        }
        if (from >= 0) v.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
      }
      if (a.makeFrontmost === false) return jsonText({ success: true, filePath: a.filePath, languageId: languageId(a.filePath), lineCount: v?.state.doc.lines ?? 0 });
      return text(`Opened file: ${a.filePath}`);
    },
  },
  {
    name: "openDiff",
    description: "Open a diff view comparing old file content with new file content",
    inputSchema: { type: "object", properties: { old_file_path: { type: "string" }, new_file_path: { type: "string" }, new_file_contents: { type: "string" }, tab_name: { type: "string" } }, required: ["old_file_path", "new_file_path", "new_file_contents", "tab_name"] },
    run: async (a, call) => {
      // Changes are applied directly (user setting): no diff UI – the CLI asks in the terminal,
      // writes the file itself and then calls close_tab, which resolves this call.
      const prev = diffs.get(a.tab_name);
      if (prev) finishDiff(a.tab_name);
      diffs.set(a.tab_name, { call, path: a.new_file_path });
      return undefined; // answered later
    },
  },
  {
    name: "getCurrentSelection",
    description: "Get the current text selection in the active editor",
    inputSchema: { type: "object", properties: {} },
    run: () => {
      const s = currentSelection();
      return jsonText(s ? { success: true, ...s } : { success: false, message: "No active editor found" });
    },
  },
  {
    name: "getLatestSelection",
    description: "Get the most recent text selection (even if not in the active editor)",
    inputSchema: { type: "object", properties: {} },
    run: () => jsonText(latest ? { success: true, ...latest } : { success: false, message: "No selection available" }),
  },
  {
    name: "getOpenEditors",
    description: "Get information about currently open editors",
    inputSchema: { type: "object", properties: {} },
    run: () =>
      jsonText({
        tabs: app.tabs.filter((t) => t.path && !t.path.startsWith("collab:")).map((t) => ({ uri: fileUri(t.path!), isActive: t.id === app.activeId, label: t.name, languageId: languageId(t.path!), isDirty: t.dirty, fileName: t.path, isUntitled: false })),
      }),
  },
  {
    name: "getWorkspaceFolders",
    description: "Get all workspace folders currently open in the IDE",
    inputSchema: { type: "object", properties: {} },
    run: () => jsonText({ success: true, folders: app.root ? [{ name: basename(app.root), uri: fileUri(app.root), path: app.root }] : [], rootPath: app.root ?? null }),
  },
  {
    name: "getDiagnostics",
    description: "Get language diagnostics (errors, warnings) from the editor",
    inputSchema: { type: "object", properties: { uri: { type: "string", description: "Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files." } } },
    run: (a) => {
      const byUri = new Map<string, any[]>();
      for (const c of allClients()) for (const [uri, list] of c.diagnostics) if (list.length) byUri.set(uri, [...(byUri.get(uri) ?? []), ...list]);
      const want = a.uri ? fileUri(uriPath(a.uri)) : null;
      const out = [...byUri].filter(([u]) => !want || u === want).map(([uri, list]) => ({
        uri,
        diagnostics: list.map((d: any) => ({ message: d.message, severity: SEVERITY[d.severity ?? 1] ?? "Error", range: d.range, source: d.source, code: d.code })),
      }));
      return jsonText(out);
    },
  },
  {
    name: "checkDocumentDirty",
    description: "Check if a document has unsaved changes",
    inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
    run: (a) => {
      const t = findTab(a.filePath);
      return jsonText(t ? { success: true, filePath: a.filePath, isDirty: t.dirty, isUntitled: false } : { success: false, message: `Document not open: ${a.filePath}` });
    },
  },
  {
    name: "saveDocument",
    description: "Save a document with unsaved changes",
    inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
    run: async (a) => {
      const t = findTab(a.filePath);
      if (!t) return jsonText({ success: false, message: `Document not open: ${a.filePath}` });
      await save(t.id);
      return jsonText({ success: true, filePath: a.filePath, saved: true, message: "Document saved successfully" });
    },
  },
  {
    name: "close_tab",
    description: "Close a tab by name",
    inputSchema: { type: "object", properties: { tab_name: { type: "string" } }, required: ["tab_name"] },
    run: (a) => (finishDiff(a.tab_name), text("TAB_CLOSED")),
  },
  {
    name: "closeAllDiffTabs",
    description: "Close all diff tabs in the editor",
    inputSchema: { type: "object", properties: {} },
    run: () => {
      const n = diffs.size;
      for (const k of [...diffs.keys()]) finishDiff(k);
      return text(`CLOSED_${n}_DIFF_TABS`);
    },
  },
];

listen<{ call: number; conn: number; name: string; args: Args }>("ide-call", async (e) => {
  const { call, name, args } = e.payload;
  const tool = TOOLS.find((t) => t.name === name);
  try {
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const r = await tool.run(args ?? {}, call);
    if (r !== undefined) invoke("ide_reply", { call, result: r });
  } catch (err) {
    invoke("ide_reply", { call, result: { __error: String(err instanceof Error ? err.message : err) } });
  }
});

// ------------------------------------------------------------------ agents

export interface Agent {
  id: "claude" | "codex" | "opencode";
  label: string;
  cmd: string;
  /** clientInfo.name when connected over the IDE WebSocket. */
  wsName?: string;
  /** Typed into the agent after start (Codex: switch on IDE context). */
  after?: string;
}
export const AGENTS: Agent[] = [
  { id: "claude", label: "Claude Code", cmd: "claude", wsName: "claude-code" },
  { id: "codex", label: "Codex", cmd: "codex", after: "/ide on" },
  { id: "opencode", label: "OpenCode", cmd: "opencode", wsName: "opencode" },
];

export const ideLink = $state({
  port: 0,
  /** clientInfo names of connected WebSocket agents (Claude Code, OpenCode). */
  clients: [] as string[],
  codex: "" as string, // "listening" | "busy" | "error"
  codexLastRequest: 0,
  installed: {} as Record<string, boolean>,
});

export const isConnected = (a: Agent) =>
  a.wsName ? ideLink.clients.some((c) => c.toLowerCase().includes(a.wsName!)) : Date.now() - ideLink.codexLastRequest < 10 * 60_000 && ideLink.codexLastRequest > 0;

export async function detectAgents() {
  for (const a of AGENTS) ideLink.installed[a.id] = !!(await invoke<string | null>("which_cmd", { cmd: a.cmd }).catch(() => null));
}

const agentTabs = new Map<string, Agent["id"]>(); // terminal id → agent

/** Opens a terminal tab running the agent in the project folder. */
export function startAgent(id: Agent["id"]) {
  const a = AGENTS.find((x) => x.id === id)!;
  const tid = newTerminalWith(a.cmd, app.root, a.label);
  agentTabs.set(tid, id);
  if (a.after) setTimeout(() => invoke("pty_write", { id: tid, data: `${a.after}\r` }).catch(() => {}), 3500);
}
export const startClaude = () => startAgent("claude");

// ------------------------------------------------------------------ notifications

let lastKey = "";
let timer = 0;
let lastCodexKey = "";
function relPath(p: string) {
  return app.root && p.startsWith(app.root + "/") ? p.slice(app.root.length + 1) : p;
}
function pollSelection() {
  const s = currentSelection();
  const key = s ? `${s.filePath}:${s.selection.start.line}:${s.selection.start.character}:${s.selection.end.line}:${s.selection.end.character}` : "none";
  // Codex pulls its context from us (codex_ipc.rs) → keep it current.
  const tabs = app.tabs.filter((t) => t.path && !t.path.startsWith("collab:"));
  const codexKey = key + tabs.map((t) => t.path).join("|");
  if (codexKey !== lastCodexKey) {
    lastCodexKey = codexKey;
    invoke("codex_set_context", {
      context: {
        activeFile: s ? { label: basename(s.filePath), path: relPath(s.filePath), fsPath: s.filePath, selection: s.selection, activeSelectionContent: s.text, selections: [] } : null,
        openTabs: tabs.map((t) => ({ label: t.name, path: relPath(t.path!) })),
      },
    });
  }
  if (!ideLink.clients.length || key === lastKey) return;
  lastKey = key;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (s) {
      latest = s;
      invoke("ide_notify", { method: "selection_changed", params: s });
    }
  }, 100);
}
setInterval(pollSelection, 200);

/** Sends the current selection to the agent: @-mention (Claude Code, OpenCode) or a typed reference (Codex). */
export function mentionSelection() {
  const s = currentSelection();
  if (!s) return ui.toast(t("ai.noActiveFile"), "error");
  const live = (id: string) => terms.tabs.some((t) => t.id === id && !t.exited);
  // Prefer the visible agent terminal, else any agent terminal.
  let tid = terms.active && agentTabs.has(terms.active) && live(terms.active) ? terms.active : [...agentTabs.keys()].find(live) ?? null;
  const agent = tid ? agentTabs.get(tid) : null;
  const end = s.selection.end.character === 0 && s.selection.end.line > s.selection.start.line ? s.selection.end.line - 1 : s.selection.end.line;
  if (agent === "codex") {
    const range = s.selection.isEmpty ? `:${s.selection.start.line + 1}` : `:${s.selection.start.line + 1}-${end + 1}`;
    invoke("pty_write", { id: tid, data: `${relPath(s.filePath)}${range} ` });
  } else if (ideLink.clients.length) {
    invoke("ide_notify", { method: "at_mentioned", params: { filePath: s.filePath, lineStart: s.selection.start.line, lineEnd: end } });
  } else return ui.toast(t("ai.noAgent"), "error");
  if (tid) terms.active = tid;
  showView("terminal");
  setTimeout(() => tid && focusTerm(tid), 50);
}

// ------------------------------------------------------------------ lifecycle

listen<string[]>("ide-clients", (e) => {
  const before = ideLink.clients.filter(Boolean).length;
  ideLink.clients = e.payload.filter(Boolean);
  if (ideLink.clients.length > before) {
    lastKey = "";
    const name = ideLink.clients[ideLink.clients.length - 1];
    const a = AGENTS.find((x) => x.wsName && name.toLowerCase().includes(x.wsName));
    ui.toast(t("ai.agentConnected", { name: a?.label ?? name }));
  }
});
listen("codex-ide-request", () => {
  if (!ideLink.codexLastRequest) ui.toast(t("ai.agentConnected", { name: "Codex" }));
  ideLink.codexLastRequest = Date.now();
});

invoke<number>("ide_start", { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), folders: app.root ? [app.root] : [] }).then((p) => (ideLink.port = p));
invoke<{ port: number; clients: string[] }>("ide_info").then((i) => {
  ideLink.port = i.port;
  ideLink.clients = i.clients.filter(Boolean);
});
invoke<string>("codex_status").then((st) => (ideLink.codex = st));
detectAgents();

// Keep workspaceFolders in the lock file in sync with the open project.
$effect.root(() => {
  $effect(() => {
    const root = app.root;
    invoke("ide_set_folders", { folders: root ? [root] : [] });
  });
});

// Event listeners/intervals live at module level → full reload instead of duplicate HMR instances.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
