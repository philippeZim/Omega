/** Minimal LSP client: one server process per (server kind, project root), full-text document sync. */
import { backendErrorText } from "../backendError";
import { invoke } from "@tauri-apps/api/core";
import { onRpc } from "../rpc";
import { t } from "../i18n/index.svelte";
import { ui } from "../ui.svelte";
import { fsApi, dirname, joinPath, isRoot } from "../api";
import { OS, platform } from "../platform";
import { ensureTools, withInstallProgress, serverProgressId, type ToolId } from "../tools.svelte";
import type { LangInfo } from "./languages";

type Json = any;

export type ServerKind = NonNullable<LangInfo["server"]>;
export type ServerStatus = "starting" | "ready" | "missing" | "installing" | "error" | "stopped";

export const lspState = $state({
  status: {} as Record<string, ServerStatus>,
  message: {} as Record<string, string>,
});

/** file URI for a path ("/a/b" → file:///a/b, "C:/a" → file:///c%3A/a like VS Code). */
export const fileUri = (path: string) => {
  const win = /^[A-Za-z]:\//.test(path);
  const p = win ? "/" + path[0].toLowerCase() + path.slice(1) : path;
  return "file://" + p.split("/").map(encodeURIComponent).join("/");
};
export const uriPath = (uri: string) => {
  const p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  // file:///c:/x → C:/x
  return /^\/[A-Za-z]:/.test(p) ? p[1].toUpperCase() + p.slice(2) : p;
};

/**
 * The part of a server's stderr tail worth showing in a toast: the last line that looks like an
 * error. Servers also log unrelated debug output there (rust-analyzer: "garbage collection took …").
 */
export function exitReason(tail: string[]): string {
  const line = [...tail].reverse().find((l) => /\b(error|panic|panicked|fatal|exception|failed|cannot|could not|abort(ed)?)\b/i.test(l))?.trim();
  if (!line) return "";
  return ": " + (line.length > 200 ? line.slice(0, 199) + "…" : line);
}

export class LspClient {
  readonly id: string;
  private seq = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  capabilities: Json = {};
  ready: Promise<void>;
  /** uri -> version of what the server has */
  docs = new Map<string, { version: number; text: string }>();
  diagnostics = new Map<string, Json[]>();
  diagnosticListeners = new Set<(uri: string) => void>();
  /** Called once the process exited (crash or stop), so editors can reconnect. */
  exitListeners = new Set<() => void>();
  /** Has had a document open (a fresh client without documents is not idle yet). */
  used = false;
  alive = true;
  stopping = false;
  /** Start failed: the process was killed and its late exit must not touch the status. */
  failed = false;

  constructor(readonly kind: ServerKind, readonly root: string, cmd: string, args: string[], readonly initOptions?: Json) {
    this.id = `lsp-${kind}-${Math.random().toString(36).slice(2, 8)}`;
    const tail: string[] = [];
    onRpc(this.id, {
      message: (m) => this.handle(m),
      stderr: (line) => {
        tail.push(line);
        if (tail.length > 6) tail.shift();
      },
      exit: () => {
        this.alive = false;
        // Fail in-flight requests now instead of letting them hang until their timeout.
        const err = new Error(t("code.lsp.exited", { kind: this.kind, tail: exitReason(tail) }));
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        // A stopped client can exit after its replacement started: leave the replacement's state alone.
        if (this.current && !this.failed) {
          lspState.status[this.key] = "stopped";
          lspState.message[this.key] = tail.join("\n");
          clients.delete(this.key);
        }
        for (const l of this.exitListeners) l();
        if (!this.stopping) ui.toast(t("code.lsp.exited", { kind: this.kind, tail: exitReason(tail) }), "error");
      },
    });
    this.ready = this.start(cmd, args);
  }

  get key() {
    return `${this.kind}|${this.root}`;
  }

  /** False once another client is registered for this key (this one was stopped and replaced). */
  get current() {
    const c = clients.get(this.key);
    return !c || c === this;
  }

  private async start(cmd: string, args: string[]) {
    lspState.status[this.key] = "starting";
    await invoke("proc_spawn", { id: this.id, cmd, args, cwd: this.root });
    const res = await this.request("initialize", {
      processId: null,
      rootUri: fileUri(this.root),
      rootPath: this.root,
      workspaceFolders: [{ uri: fileUri(this.root), name: this.root.split("/").pop() }],
      clientInfo: { name: "Omega" },
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              insertReplaceSupport: true,
              labelDetailsSupport: true,
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
            contextSupport: true,
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } } },
          definition: { linkSupport: true },
          formatting: {},
          // codeActionsInline: clangd extension – fixes (e.g. "Include <stdio.h>") arrive with the diagnostic.
          publishDiagnostics: { relatedInformation: false, codeActionsInline: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source"] } }, isPreferredSupport: true },
        },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
      initializationOptions: this.initOptions ?? (this.kind === "rust" ? { checkOnSave: true } : undefined),
    });
    this.capabilities = res?.capabilities ?? {};
    this.notify("initialized", {});
    if (this.current) lspState.status[this.key] = "ready";
  }

  private send(msg: Json) {
    return invoke("proc_send", { id: this.id, msg: JSON.stringify({ jsonrpc: "2.0", ...msg }) });
  }

  request<T = Json>(method: string, params: Json, timeoutMs = 15000): Promise<T> {
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: Timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  notify(method: string, params: Json) {
    if (!this.alive) return;
    this.send({ method, params }).catch(() => {});
  }

  private handle(msg: Json) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // Requests from the server.
      let result: Json = null;
      if (msg.method === "workspace/configuration") result = (msg.params?.items ?? []).map((it: Json) => serverSetting(this.kind, it.section));
      else if (msg.method === "workspace/workspaceFolders") result = [{ uri: fileUri(this.root), name: this.root }];
      else if (msg.method === "workspace/applyEdit") result = { applied: false };
      this.send({ id: msg.id, result });
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      // Servers spell Windows URIs differently (file:///C:/ vs file:///c%3A/): use our form.
      const uri = fileUri(uriPath(msg.params.uri));
      this.diagnostics.set(uri, msg.params.diagnostics);
      for (const l of this.diagnosticListeners) l(uri);
    } else if (msg.method === "window/showMessage" && msg.params?.type <= 2 && this.current) {
      lspState.message[this.key] = msg.params.message;
    }
  }

  // ---------------------------------------------------------- documents

  open(uri: string, languageId: string, text: string) {
    const d = this.docs.get(uri);
    if (d) return this.change(uri, text);
    this.docs.set(uri, { version: 1, text });
    this.used = true;
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
  }

  change(uri: string, text: string) {
    const d = this.docs.get(uri);
    if (!d || d.text === text) return;
    d.version++;
    d.text = text;
    this.notify("textDocument/didChange", { textDocument: { uri, version: d.version }, contentChanges: [{ text }] });
  }

  save(uri: string, text: string) {
    if (this.docs.has(uri)) this.notify("textDocument/didSave", { textDocument: { uri }, text });
  }

  close(uri: string) {
    if (!this.docs.delete(uri)) return;
    this.notify("textDocument/didClose", { textDocument: { uri } });
    if (!this.docs.size) stopIdle();
  }

  stop() {
    this.stopping = true;
    this.request("shutdown", null, 2000)
      .catch(() => {})
      .finally(() => {
        this.notify("exit", null);
        // The process may be gone already, or the IPC with it (app or test teardown).
        setTimeout(() => invoke("proc_kill", { id: this.id }).catch(() => {}), 300);
      });
  }
}

// ---------------------------------------------------------- server registry

const clients = new Map<string, LspClient>();
const starting = new Map<string, Promise<LspClient | null>>();
/** Servers whose install prompt was cancelled: not asked again this session (until stopServers). */
const declined = new Set<ServerKind>();
/** Keys whose server failed to start: not retried for every new tab (only after stopServers). */
const failed = new Set<string>();

let currentWorkspace: () => string | null = () => null;
/** Lets the registry see the open folder (set together with the editor hooks). */
export function setLspWorkspace(get: () => string | null) {
  currentWorkspace = get;
}

const related = (root: string, ws: string) => root === ws || root.startsWith(ws + "/") || ws.startsWith(root + "/");

/** Stops servers without open documents whose project is not the open folder (e.g. after a folder switch). */
function stopIdle() {
  const ws = currentWorkspace();
  for (const [key, c] of clients)
    if (c.used && !c.docs.size && !c.stopping && !(ws && related(c.root, ws))) {
      c.stop();
      clients.delete(key);
      delete lspState.status[key];
      delete lspState.message[key];
    }
}

const ROOT_MARKERS: Record<ServerKind, string[]> = {
  python: ["pyproject.toml", "setup.py", "requirements.txt", ".git"],
  clangd: ["compile_commands.json", "CMakeLists.txt", "Makefile", ".git"],
  java: ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "pom.xml", ".git"],
  typescript: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
  rust: ["Cargo.toml"],
};

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");

/** Walks up from the file to find the project root (stops at the workspace root's parent). */
export async function findRoot(file: string, markers: string[], workspace: string | null): Promise<string> {
  let dir = dirname(file);
  const stop = workspace ? dirname(workspace) : "/";
  const candidates: string[] = [];
  while (dir && dir !== stop && !isRoot(dir)) {
    for (const m of markers) if (await fsApi.exists(joinPath(dir, m))) candidates.push(dir);
    if (candidates.length && markers[0] !== "Cargo.toml") break;
    dir = dirname(dir);
  }
  // For Cargo workspaces the outermost Cargo.toml is the root.
  return candidates.length ? candidates[candidates.length - 1] : (workspace ?? dirname(file));
}

let toolsDirCache: string | null = null;
export async function toolsDir() {
  return (toolsDirCache ??= await invoke<string>("tools_dir"));
}

/** java-debug plugin jars (loaded into jdtls as bundles to enable Java debugging). */
export async function javaDebugBundles(): Promise<string[]> {
  try {
    return (await fsApi.listDir(`${await toolsDir()}/java-debug`)).filter((e) => e.name.endsWith(".jar")).map((e) => e.path);
  } catch {
    return [];
  }
}

/** Strict Python type checking (basedpyright's "recommended" mode); off by default. */
export const lspSettings = $state({ strictPython: localStorage.getItem("strictPython") === "true" });

/**
 * Answers for `workspace/configuration`. basedpyright requests the "python" and "basedpyright"
 * sections and reads `analysis.typeCheckingMode`. Its default "recommended" mode flags every
 * unannotated parameter, so unless strict checking is on we use pyright's "standard" mode.
 * A project's own pyrightconfig.json / [tool.basedpyright] still takes precedence.
 */
function serverSetting(kind: ServerKind, section?: string): Json {
  if (kind === "python" && (section === "basedpyright" || section === "python"))
    return { analysis: { typeCheckingMode: lspSettings.strictPython ? "recommended" : "standard" } };
  return null;
}

export function setStrictPython(on: boolean) {
  lspSettings.strictPython = on;
  localStorage.setItem("strictPython", String(on));
  // Running servers re-pull their configuration and re-check open files.
  for (const c of clients.values()) if (c.kind === "python") c.notify("workspace/didChangeConfiguration", { settings: null });
}

async function resolveCommand(kind: ServerKind, root: string): Promise<{ cmd: string; args: string[]; init?: Json } | null> {
  const tools = await toolsDir();
  const which = (c: string) => invoke<string | null>("which_cmd", { cmd: c });
  const first = async (...cands: string[]) => {
    for (const c of cands) {
      const p = await which(c);
      if (p) return p;
    }
    return null;
  };
  switch (kind) {
    case "python": {
      const cmd = await first(`${tools}/python/node_modules/.bin/basedpyright-langserver`, "basedpyright-langserver", "pyright-langserver");
      return cmd ? { cmd, args: ["--stdio"] } : null;
    }
    case "typescript": {
      const cmd = await first(`${tools}/typescript/node_modules/.bin/typescript-language-server`, "typescript-language-server");
      return cmd ? { cmd, args: ["--stdio"] } : null;
    }
    case "clangd": {
      const cmd = await first("clangd");
      return cmd ? { cmd, args: ["--background-index", "--clang-tidy", "--header-insertion=never", "--completion-style=detailed"] } : null;
    }
    case "rust": {
      const ok = await invoke<boolean>("cmd_works", { cmd: "rust-analyzer" });
      return ok ? { cmd: "rust-analyzer", args: [] } : null;
    }
    case "java": {
      let h = 0;
      for (const c of root) h = (h * 31 + c.charCodeAt(0)) | 0;
      const data = `${tools}/jdtls-workspace/${(h >>> 0).toString(16)}`;
      const bundles = await javaDebugBundles();
      const init = bundles.length ? { bundles } : undefined;
      // Omega's own jdtls is started with `java -jar` directly (its bin/jdtls wrapper needs Python).
      const home = `${tools}/jdtls`;
      const launcher = (await fsApi.listDir(`${home}/plugins`).catch(() => [])).find((e) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(e.name));
      const java = await which("java");
      if (launcher && java) {
        const arm = (await platform()).arch === "aarch64";
        const config = `${home}/config_${OS === "windows" ? "win" : OS === "macos" ? "mac" : "linux"}${arm && OS !== "windows" ? "_arm" : ""}`;
        return {
          cmd: java,
          args: [
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dosgi.checkConfiguration=true",
            `-Dosgi.sharedConfiguration.area=${config}`,
            "-Dosgi.sharedConfiguration.area.readOnly=true",
            "-Dosgi.configuration.cascaded=true",
            "-Xms1G",
            "--add-modules=ALL-SYSTEM",
            "--add-opens", "java.base/java.util=ALL-UNNAMED",
            "--add-opens", "java.base/java.lang=ALL-UNNAMED",
            "-jar", launcher.path,
            "-configuration", `${tools}/jdtls-config`,
            "-data", data,
          ],
          init,
        };
      }
      const cmd = await first("jdtls");
      return cmd ? { cmd, args: ["-data", data], init } : null;
    }
  }
}

export const INSTALLABLE: Partial<Record<ServerKind, string>> = {
  python: "basedpyright (Python)",
  clangd: "clangd (C/C++)",
  typescript: "typescript-language-server (JS/TS)",
  java: "Eclipse JDT Language Server (Java)",
  get rust() {
    return t("code.lsp.rustAnalyzer");
  },
};

/** Tools a language server installation builds on. */
const PREREQ: Partial<Record<ServerKind, ToolId[]>> = { python: ["node"], typescript: ["node"], java: ["jdk"], rust: ["rust"] };

/**
 * Returns a running client for this file's server, starting it if necessary.
 * `askInstall` is called when the server is missing; it should return true to install.
 */
export async function clientFor(
  lang: LangInfo,
  file: string,
  workspace: string | null,
  askInstall: (kind: ServerKind, name: string) => Promise<boolean>,
  /** Java: make sure jdtls runs with the java-debug bundle (restarts it if needed). */
  needDebug = false,
): Promise<LspClient | null> {
  const kind = lang.server;
  if (!kind) return null;
  stopIdle();
  // A file outside the open folder (Go to Definition into a library, the Rust std sources, system
  // headers) is served by the server already running for the folder, not a new one rooted there.
  if (workspace && !within(file, workspace)) {
    const own = [...clients.values()].find((c) => c.kind === kind && !c.stopping && within(c.root, workspace)) ?? [...clients.values()].find((c) => c.kind === kind && !c.stopping);
    if (own) return own.ready.then(() => own);
    // Never index the toolchain itself (rust-analyzer's flycheck writes target/ into it).
    if (kind === "rust" && /\/lib\/rustlib\/src\//.test(file)) return null;
  }
  const root = await findRoot(file, ROOT_MARKERS[kind], workspace);
  const key = `${kind}|${root}`;
  const existing = clients.get(key);
  if (existing && needDebug && kind === "java" && !existing.initOptions?.bundles) {
    existing.stop();
    clients.delete(key);
  } else if (existing) return existing.ready.then(() => existing);
  if (starting.has(key)) return starting.get(key)!;
  if (failed.has(key)) return null;

  const p = (async () => {
    let cmd = await resolveCommand(kind, root);
    if (!cmd) {
      lspState.status[key] = "missing";
      const name = INSTALLABLE[kind];
      if (!name || (declined.has(kind) && !needDebug)) return null;
      if (!(await askInstall(kind, name))) {
        declined.add(kind);
        return null;
      }
      const prereq = PREREQ[kind];
      if (prereq && !(await ensureTools(prereq, t("tools.purpose.lsp")))) {
        declined.add(kind);
        lspState.status[key] = "missing";
        return null;
      }
      lspState.status[key] = "installing";
      try {
        await withInstallProgress(serverProgressId(kind), name, () => invoke("install_server", { kind }));
      } catch (e) {
        lspState.status[key] = "error";
        lspState.message[key] = backendErrorText(e);
        ui.toast(t("code.lsp.installFailed", { err: backendErrorText(e) }), "error");
        return null;
      }
      cmd = await resolveCommand(kind, root);
      if (!cmd) return null;
    }
    const c = new LspClient(kind, root, cmd.cmd, cmd.args, cmd.init);
    clients.set(key, c);
    try {
      await c.ready;
      return c;
    } catch (e) {
      // Died during initialize: the exit handler already kept the stderr tail as message and showed a toast.
      const exited = !c.alive;
      failed.add(key);
      if (!exited) {
        // The process may still run (e.g. it answered initialize with an error): kill it.
        c.failed = c.stopping = true;
        invoke("proc_kill", { id: c.id }).catch(() => {});
      }
      if (c.current) {
        lspState.status[key] = "error";
        if (!exited) lspState.message[key] = backendErrorText(e);
        clients.delete(key);
      }
      if (!exited) ui.toast(t("code.lsp.startFailed", { kind, err: String(e) }), "error");
      return null;
    }
  })();
  starting.set(key, p);
  const r = await p;
  starting.delete(key);
  return r;
}

/** Stops all running servers of `kind` (before it is updated or removed); they restart on demand. */
export function stopServers(kind: ServerKind) {
  declined.delete(kind);
  for (const key of failed) if (key.startsWith(kind + "|")) failed.delete(key);
  for (const [key, c] of clients) if (c.kind === kind) {
    c.stop();
    clients.delete(key);
    delete lspState.status[key];
  }
}

/** Called after restartServer, so editors without a client (failed or missing server) connect again. */
export const restartListeners = new Set<() => void>();

/**
 * Restarts the server for this file (the status indicator's action). A missing server is
 * offered for installation again, even after the prompt was cancelled.
 */
export async function restartServer(
  lang: LangInfo,
  file: string,
  workspace: string | null,
  askInstall: (kind: ServerKind, name: string) => Promise<boolean>,
): Promise<LspClient | null> {
  const kind = lang.server;
  if (!kind) return null;
  const key = `${kind}|${await findRoot(file, ROOT_MARKERS[kind], workspace)}`;
  if (starting.has(key)) return starting.get(key)!;
  declined.delete(kind);
  failed.delete(key);
  const old = clients.get(key);
  if (old) {
    old.stop(); // its exit makes the editors reconnect to the new client
    clients.delete(key);
  }
  delete lspState.status[key];
  delete lspState.message[key];
  const c = await clientFor(lang, file, workspace, askInstall);
  for (const l of restartListeners) l();
  return c;
}

export function allClients() {
  return [...clients.values()];
}

export function statusFor(lang: LangInfo | null, file: string | null): { status: ServerStatus | null; message?: string } {
  if (!lang?.server || !file) return { status: null };
  // Find the client whose root contains the file (most specific).
  let best: string | null = null;
  for (const key of Object.keys(lspState.status)) {
    const [kind, root] = key.split("|");
    if (kind === lang.server && file.startsWith(root + "/") && (!best || root.length > best.split("|")[1].length)) best = key;
  }
  return best ? { status: lspState.status[best], message: lspState.message[best] } : { status: null };
}
