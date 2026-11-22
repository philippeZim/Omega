/** Minimal LSP client: one server process per (server kind, project root), full-text document sync. */
import { backendErrorText } from "../backendError";
import { onGlobalChange } from "../windowStorage";
import { invoke } from "@tauri-apps/api/core";
import { onRpc } from "../rpc";
import { t, type Key } from "../i18n/index.svelte";
import { ui } from "../ui.svelte";
import { fsApi, dirname, joinPath, isRoot } from "../api";
import { IS_WIN, OS, platform, exe } from "../platform";
import { ensureTools, mojoInstallHint, withInstallProgress, serverProgressId, type ToolId } from "../tools.svelte";
import { metalsPausedBy, onGuestChange, resumeTool, toolChangeCount, toolPausedBy, type PausedTool } from "../collab/guestChanges";
import type { LangInfo } from "./languages";
import { isForeignLang } from "./langOverride.svelte";

type Json = any;

export type ServerKind = NonNullable<LangInfo["server"]>;
export type ServerStatus = "starting" | "ready" | "missing" | "installing" | "error" | "stopped";

export const lspState = $state({
  status: {} as Record<string, ServerStatus>,
  message: {} as Record<string, string>,
  /** How a file set to another language is served (see `setLspRoute`). */
  routes: {} as Record<string, LspRoute>,
});

/** pending: still deciding; project: the project's server; shadow: a private copy; none: no server. */
export type LspRoute = "pending" | "project" | "shadow" | "none";

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

/** Metals starts a JVM and may fetch its presentation compiler before it answers `initialize`. */
const METALS_INIT_MS = 120_000;

/**
 * Answers Metals' prompts: import the build (without it an sbt project has no build target, so
 * no completion and no debugging), and prefer sbt when a folder also looks like a scala-cli
 * project, as Run does. Anything else (Doctor, HTTP server hints) stays unanswered.
 */
export function metalsAnswer(params: Json): Json {
  const actions: { title: string }[] = params?.actions ?? [];
  return actions.find((a) => /^(import build|import changes)$/i.test(a.title)) ?? actions.find((a) => a.title.toLowerCase() === "sbt") ?? null;
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
  /** uri -> the document version the last diagnostics were computed for, if the server said. */
  diagnosticVersions = new Map<string, number | undefined>();
  /** uri -> when its text last changed, to judge results from servers that don't send a version. */
  textChangedAt = new Map<string, number>();
  diagnosticListeners = new Set<(uri: string) => void>();
  /** Called once the process exited (crash or stop), so editors can reconnect. */
  exitListeners = new Set<() => void>();
  /** Has had a document open (a fresh client without documents is not idle yet). */
  used = false;
  alive = true;
  stopping = false;
  /** Start failed: the process was killed and its late exit must not touch the status. */
  failed = false;
  /** TypeScript project whose dependencies are still being installed: a failed start is not reported. */
  quiet = false;
  /** Runs on a private copy of one file, so it ends with that file (see `releasePrivate`). */
  privateCopy = false;
  /** Documents an editor has open (between `open` and `close`). */
  private editorDocs = new Set<string>();
  /** uri -> live text of a document kept open for Code Together guests (see `feed`). */
  private feeds = new Map<string, () => string>();

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
        if (!this.stopping && !this.quiet) ui.toast(t("code.lsp.exited", { kind: this.kind, tail: exitReason(tail) }), "error");
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
          declaration: { linkSupport: true },
          implementation: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          documentHighlight: {},
          formatting: {},
          // codeActionsInline: clangd extension – fixes (e.g. "Include <stdio.h>") arrive with the diagnostic.
          publishDiagnostics: { relatedInformation: false, codeActionsInline: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source"] } }, isPreferredSupport: true },
        },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
      initializationOptions: this.initOptions ?? (this.kind === "rust" ? { checkOnSave: true } : undefined),
    }, this.kind === "scala" ? METALS_INIT_MS : undefined);
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
      else if (msg.method === "window/showMessageRequest" && this.kind === "scala") result = this.stopping || metalsPausedBy(this.root) !== null ? null : metalsAnswer(msg.params);
      this.send({ id: msg.id, result });
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      // Servers spell Windows URIs differently (file:///C:/ vs file:///c%3A/): use our form.
      const uri = fileUri(uriPath(msg.params.uri));
      this.diagnostics.set(uri, msg.params.diagnostics);
      this.diagnosticVersions.set(uri, Number.isInteger(msg.params.version) ? msg.params.version : undefined);
      for (const l of this.diagnosticListeners) l(uri);
    } else if (msg.method === "window/showMessage" && msg.params?.type <= 2 && this.current) {
      lspState.message[this.key] = msg.params.message;
    }
  }

  // ---------------------------------------------------------- documents

  open(uri: string, languageId: string, text: string) {
    this.editorDocs.add(uri);
    if (this.docs.has(uri)) return this.change(uri, text);
    this.openDoc(uri, languageId, text);
  }

  private openDoc(uri: string, languageId: string, text: string) {
    this.docs.set(uri, { version: 1, text });
    this.textChangedAt.set(uri, Date.now());
    this.used = true;
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
  }

  change(uri: string, text: string) {
    const d = this.docs.get(uri);
    // A fed document has one source of truth, whoever asks for the sync.
    const next = this.feeds.get(uri)?.() ?? text;
    if (!d || d.text === next) return;
    d.version++;
    d.text = next;
    this.textChangedAt.set(uri, Date.now());
    this.notify("textDocument/didChange", { textDocument: { uri, version: d.version }, contentChanges: [{ text: next }] });
  }

  /** Sends the unchanged text again, so the server analyses it and reports on exactly this text. */
  resend(uri: string) {
    const d = this.docs.get(uri);
    if (!d) return;
    d.version++;
    this.notify("textDocument/didChange", { textDocument: { uri, version: d.version }, contentChanges: [{ text: d.text }] });
  }

  /**
   * Keeps a document open independently of any editor, with `read` as its text: a Code Together
   * document guests have open. An editor on the same file shares the one server document.
   */
  feed(uri: string, languageId: string, read: () => string) {
    this.feeds.set(uri, read);
    if (this.docs.has(uri)) this.change(uri, read());
    else this.openDoc(uri, languageId, read());
  }

  /** Ends `feed`. The document closes unless an editor still has it open. */
  unfeed(uri: string) {
    if (this.feeds.delete(uri) && !this.editorDocs.has(uri)) this.closeDoc(uri);
  }

  save(uri: string, text: string) {
    if (this.docs.has(uri)) this.notify("textDocument/didSave", { textDocument: { uri }, text });
  }

  close(uri: string) {
    this.editorDocs.delete(uri);
    if (!this.feeds.has(uri)) this.closeDoc(uri);
  }

  private closeDoc(uri: string) {
    if (!this.docs.delete(uri)) return;
    // What the server said was about this open text: a reopened document starts clean.
    this.diagnostics.delete(uri);
    this.diagnosticVersions.delete(uri);
    this.textChangedAt.delete(uri);
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

// ---------------------------------------------------------- files set to another language

/** Real file -> the private copy its language server works on (see langRun.ts). */
const shadows = new Map<string, string>();
/** Folder of such a copy -> the real file. */
const shadowRoots = new Map<string, string>();

/** Private copy -> its real file and the folder its server runs in (above it for a Java package). */
const copies = new Map<string, { real: string; root: string }>();

export function registerShadow(real: string, copy: string, root = dirname(copy)) {
  shadows.set(real, copy);
  copies.set(copy, { real, root });
  shadowRoots.set(root, real);
  lspState.routes[real] = "shadow";
}

export const setLspRoute = (path: string, route: LspRoute) => void (lspState.routes[path] = route);

/** The file the language server sees for `file`. */
export const shadowOf = (file: string) => shadows.get(file) ?? file;

/** The real file behind a path a language server reported. */
export const realPathOf = (path: string) => copies.get(path)?.real ?? path;

/** Guest pauses are about the real project, also for a server working on a private copy. */
const pauseRootOf = (root: string) => {
  const real = shadowRoots.get(root);
  return real ? dirname(real) : root;
};

/** A private copy's server has no document left: it stops, also while it's still starting. */
function stopPrivate(root: string) {
  for (const [key, c] of clients) {
    if (c.root !== root || c.docs.size || c.stopping) continue;
    if (lspState.status[key] === "starting") {
      c.failed = c.stopping = true;
      invoke("proc_kill", { id: c.id }).catch(() => {});
    } else c.stop();
    clients.delete(key);
    delete lspState.status[key];
    delete lspState.message[key];
  }
}

/** A server that finished starting after its file was closed: nobody will use it. */
export function releasePrivate(c: LspClient) {
  if (c.privateCopy && !shadowRoots.has(c.root)) stopPrivate(c.root);
}

/** The file's tab closed, it moved, or its language changed: no server keeps it open. */
export function closeLspDoc(path: string) {
  const copy = shadows.get(path);
  for (const c of [...clients.values()]) {
    c.close(fileUri(path));
    if (copy) c.close(fileUri(copy));
  }
  shadows.delete(path);
  delete lspState.routes[path];
  if (!copy) return;
  const root = copies.get(copy)?.root ?? dirname(copy);
  stopPrivate(root);
  copies.delete(copy);
  shadowRoots.delete(root);
}

/** The file was saved: a private copy is refreshed first, since servers re-read the disk on save. */
export async function saveLspDoc(path: string, text: string) {
  const copy = shadows.get(path);
  if (copy) {
    await invoke("lang_copy", { file: path, part: "lsp", name: copy.slice((copies.get(copy)?.root ?? dirname(copy)).length + 1), link: false }).catch(() => {});
    if (shadows.get(path) !== copy) return;
  }
  const uri = fileUri(copy ?? path);
  for (const c of clients.values()) c.save(uri, text);
}

const ROOT_MARKERS: Record<ServerKind, string[]> = {
  python: ["pyproject.toml", "setup.py", "requirements.txt", ".git"],
  clangd: ["compile_commands.json", "CMakeLists.txt", "Makefile", ".git"],
  java: ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "pom.xml", ".git"],
  typescript: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
  rust: ["Cargo.toml"],
  scala: ["build.sbt", "project.scala", ".bsp", ".scala-build", ".git"],
  ocaml: ["dune-project", "dune-workspace"],
  mojo: ["mojoproject.toml", "pixi.toml", ".git"],
  go: ["go.work", "go.mod"],
};

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");

/** Build systems whose root is the outermost marker, so a multi-package repo gets one server. */
const OUTERMOST_ROOT = new Set(["Cargo.toml", "dune-project", "go.work"]);

/** Walks up from the file to find the project root (stops at the workspace root's parent). */
export async function findRoot(file: string, markers: string[], workspace: string | null): Promise<string> {
  let dir = dirname(file);
  const stop = workspace ? dirname(workspace) : "/";
  const candidates: string[] = [];
  while (dir && dir !== stop && !isRoot(dir)) {
    for (const m of markers) if (await fsApi.exists(joinPath(dir, m))) candidates.push(dir);
    if (candidates.length && !OUTERMOST_ROOT.has(markers[0])) break;
    dir = dirname(dir);
  }
  // For Cargo and dune workspaces the outermost marker is the root.
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
  if (kind === "scala" || kind === "go") return {}; // Metals and gopls read their section as an object
  return null;
}

export function setStrictPython(on: boolean) {
  lspSettings.strictPython = on;
  localStorage.setItem("strictPython", String(on));
  // Running servers re-pull their configuration and re-check open files.
  for (const c of clients.values()) if (c.kind === "python") c.notify("workspace/didChangeConfiguration", { settings: null });
}

onGlobalChange("strictPython", (v) => {
  if ((v === "true") !== lspSettings.strictPython) setStrictPython(v === "true");
});

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
      // An older managed install pulled TypeScript 7 (no lib/tsserver.js): treat it as missing so it is reinstalled.
      const managed = (await fsApi.exists(`${tools}/typescript/node_modules/typescript/lib/tsserver.js`)) ? [`${tools}/typescript/node_modules/.bin/typescript-language-server`] : [];
      const cmd = await first(...managed, "typescript-language-server");
      return cmd ? { cmd, args: ["--stdio"] } : null;
    }
    case "clangd": {
      const cmd = await first("clangd");
      return cmd ? { cmd, args: ["--background-index", "--clang-tidy", "--header-insertion=never", "--completion-style=detailed", "--fallback-style=LLVM"] } : null;
    }
    case "rust": {
      const ok = await invoke<boolean>("cmd_works", { cmd: "rust-analyzer" });
      return ok ? { cmd: "rust-analyzer", args: [] } : null;
    }
    case "java": {
      let h = 0;
      for (const c of root) h = (h * 31 + c.charCodeAt(0)) | 0;
      // A private copy's index stays beside it (not in it: jdtls would import its own data) and goes when the app exits.
      const data = shadowRoots.has(root) ? `${dirname(root)}/jdtls-data` : `${tools}/jdtls-workspace/${(h >>> 0).toString(16)}`;
      const bundles = await javaDebugBundles();
      // jdtls would take the file's folder for the source root, and a package's folder is not one.
      const sources = shadowRoots.has(root) ? { settings: { java: { project: { sourcePaths: ["."] } } } } : {};
      const init = bundles.length || shadowRoots.has(root) ? { ...(bundles.length ? { bundles } : {}), ...sources } : undefined;
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
    case "scala": {
      const cmd = await first(`${tools}/metals/${IS_WIN ? "metals.bat" : "metals"}`, "metals");
      return cmd ? { cmd, args: [] } : null;
    }
    case "ocaml": {
      const cmd = await first(`${tools}/ocaml/root/omega/bin/ocamllsp`, "ocamllsp");
      return cmd ? { cmd, args: [] } : null;
    }
    case "mojo": {
      const cmd = await first(`${tools}/mojo/bin/mojo-lsp-server`, "mojo-lsp-server");
      return cmd ? { cmd, args: [] } : null;
    }
    case "go": {
      const cmd = await first(`${tools}/go-tools/bin/${exe("gopls")}`, "gopls");
      return cmd ? { cmd, args: [] } : null;
    }
  }
}

export const INSTALLABLE: Partial<Record<ServerKind, string>> = {
  python: "basedpyright (Python)",
  clangd: "clangd (C/C++)",
  typescript: "typescript-language-server (JS/TS)",
  java: "Eclipse JDT Language Server (Java)",
  scala: "Metals (Scala)",
  // On Windows it can only come from the user's own opam: there is nothing to offer.
  ocaml: IS_WIN ? undefined : "ocaml-lsp-server (OCaml)",
  mojo: "Mojo (compiler, LSP, LLDB)",
  go: "gopls (Go)",
  get rust() {
    return t("code.lsp.rustAnalyzer");
  },
};

/** Tools a language server installation builds on. */
const PREREQ: Partial<Record<ServerKind, ToolId[]>> = { python: ["node"], typescript: ["node"], java: ["jdk"], rust: ["rust"], scala: ["jdk", "scala"], ocaml: ["ocaml"], go: ["go"] };

/** `askInstall` for work the host didn't start itself: never prompts, and doesn't count as declining. */
export const neverInstall = async (_kind: ServerKind, _name: string) => false;

/** Language server processes guests can cause (a guest could add a project marker per folder). */
export const MAX_GUEST_SERVERS = 3;
/** Servers running only because a guest needed them. */
const guestServers = new Set<string>();
const guestReserving = new Set<string>();

/** Whether a guest may start this server: it's installed and within the limit. */
async function guestMayStart(kind: ServerKind, root: string, key: string) {
  if (PAUSABLE[kind]) return false; // they run project code: Metals build.sbt and .bsp, Merlin preprocessors
  for (const k of guestServers) if (!clients.has(k) && !starting.has(k) && !guestReserving.has(k)) guestServers.delete(k);
  if (declined.has(kind) || failed.has(key)) return false;
  if (!guestServers.has(key) && guestServers.size >= MAX_GUEST_SERVERS) return false;
  guestServers.add(key);
  guestReserving.add(key);
  const cmd = await resolveCommand(kind, root).catch(() => null);
  guestReserving.delete(key);
  if (!cmd) guestServers.delete(key);
  return !!cmd;
}

/**
 * Servers that execute project-controlled code, with the texts of their guest pause.
 * mojo-lsp-server is deliberately not here: under strace it ran no project code (no `comptime`
 * evaluation, child processes, project libraries or writes). The remaining risk, its closed-source
 * parser reading a guest's `.mojoc` file, is accepted.
 */
const PAUSABLE: Partial<Record<ServerKind, { tool: PausedTool; paused: Key; title: Key; msg: Key; ok: Key }>> = {
  scala: { tool: "metals", paused: "code.lsp.metalsPaused", title: "code.lsp.metalsResumeTitle", msg: "code.lsp.metalsResumeMsg", ok: "code.lsp.metalsResumeOk" },
  ocaml: { tool: "ocaml", paused: "code.lsp.ocamlPaused", title: "code.lsp.ocamlResumeTitle", msg: "code.lsp.ocamlResumeMsg", ok: "code.lsp.ocamlResumeOk" },
  go: { tool: "gopls", paused: "code.lsp.goplsPaused", title: "code.lsp.goplsResumeTitle", msg: "code.lsp.goplsResumeMsg", ok: "code.lsp.goplsResumeOk" },
};

/** A guest without `run` changed this project: the server would execute that text, so it stays off. */
function serverHeld(kind: ServerKind, key: string, root: string) {
  const p = PAUSABLE[kind];
  if (!p || toolPausedBy(p.tool, pauseRootOf(root)) === null) return false;
  lspState.status[key] = "stopped";
  lspState.message[key] = t(p.paused);
  return true;
}

/** Whether Metals is paused for this file's project. */
export const metalsPausedFor = async (file: string, workspace: string | null) => metalsPausedBy(await findRoot(file, ROOT_MARKERS.scala, workspace)) !== null;

/** The folder ocamllsp's guest pause is checked against for this file. */
export const ocamlPauseRoot = (file: string, workspace: string | null) => findRoot(file, ROOT_MARKERS.ocaml, workspace);

/** The folder gopls' guest pause is checked against for this file. */
export const goPauseRoot = (file: string, workspace: string | null) => findRoot(file, ROOT_MARKERS.go, workspace);

onGuestChange(() => {
  for (const [key, c] of clients) {
    if (!serverHeld(c.kind, key, c.root)) continue;
    // Killed, not shut down: it must not get to act on the change during a graceful stop.
    c.failed = c.stopping = true;
    clients.delete(key);
    invoke("proc_kill", { id: c.id }).catch(() => {});
  }
});

/** The session ended: servers that only guests needed and that have no documents left stop. */
export function stopGuestServers() {
  for (const key of guestServers) {
    const c = clients.get(key);
    if (!c || c.docs.size || c.stopping) continue;
    c.stop();
    clients.delete(key);
    delete lspState.status[key];
    delete lspState.message[key];
  }
  guestServers.clear();
}

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
  // A private copy is on its own: no project, and no marker file in a folder above it counts.
  const shadowRoot = copies.get(file)?.root;
  const shadow = shadowRoot !== undefined;
  if (shadow) workspace = null;
  // A file outside the open folder (Go to Definition into a library, the Rust std sources, system
  // headers) is served by the server already running for the folder, not a new one rooted there.
  if (workspace && !within(file, workspace)) {
    const own = [...clients.values()].find((c) => c.kind === kind && !c.stopping && within(c.root, workspace)) ?? [...clients.values()].find((c) => c.kind === kind && !c.stopping);
    if (own) return own.ready.then(() => own);
    // Never index the toolchain itself (rust-analyzer's flycheck writes target/ into it).
    if (kind === "rust" && /\/lib\/rustlib\/src\//.test(file)) return null;
  }
  const root = shadowRoot ?? (await findRoot(file, ROOT_MARKERS[kind], workspace));
  const key = `${kind}|${root}`;
  if (serverHeld(kind, key, root)) return null;
  if (askInstall !== neverInstall) guestServers.delete(key); // the host wants this one itself
  else if (!clients.has(key) && !starting.has(key) && !(await guestMayStart(kind, root, key))) return null;
  const existing = clients.get(key);
  if (existing && needDebug && kind === "java" && !existing.initOptions?.bundles) {
    existing.stop();
    clients.delete(key);
  } else if (existing) return existing.ready.then(() => existing);
  if (starting.has(key)) return starting.get(key)!;
  if (failed.has(key) || installWaits.has(key)) return null;

  const p = (async () => {
    let cmd = await resolveCommand(kind, root);
    if (!cmd) {
      lspState.status[key] = "missing";
      const name = INSTALLABLE[kind];
      if (kind === "ocaml" && !name) lspState.message[key] = t("tools.ocamlWindows");
      if (kind === "mojo") {
        // Windows, an old glibc, an Intel Mac: an install could only fail, so there is no prompt.
        const hint = await mojoInstallHint();
        if (hint) {
          lspState.message[key] = hint;
          return null;
        }
      }
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
    const waitInstall = kind === "typescript" && (await tsInstallMissing(root));
    // Last check, with no await before the process starts: the steps above can take minutes.
    if (serverHeld(kind, key, root)) return null;
    // rust-analyzer needs a Cargo.toml unless it's told which lone files to look at.
    const init = shadow && kind === "rust" ? { checkOnSave: true, detachedFiles: [file] } : cmd.init;
    const c = new LspClient(kind, root, cmd.cmd, cmd.args, init);
    c.quiet = waitInstall;
    c.privateCopy = shadow;
    clients.set(key, c);
    try {
      await c.ready;
      c.quiet = false;
      return c;
    } catch (e) {
      if (c.failed) return null; // killed by the guest pause, which has set the status
      if (c.quiet) {
        // node_modules/typescript is missing (e.g. a new project's `pnpm add` still runs): wait for it.
        if (c.alive) invoke("proc_kill", { id: c.id }).catch(() => {});
        c.failed = c.stopping = true;
        if (c.current) {
          clients.delete(key);
          lspState.status[key] = "starting";
          delete lspState.message[key];
        }
        void retryAfterInstall(key, root, e, () => clientFor(lang, file, workspace, askInstall));
        return null;
      }
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

/** How long a TypeScript server waits for a running dependency install (tests shorten it). */
export const tsInstallWait = { pollMs: 1000, maxMs: 5 * 60_000 };
const installWaits = new Set<string>();

async function tsInstallMissing(root: string) {
  return (await fsApi.exists(joinPath(root, "package.json"))) && !(await fsApi.exists(joinPath(root, "node_modules/typescript/package.json")));
}

/** Starts the server again once node_modules/typescript exists; reports the start error only after a timeout. */
async function retryAfterInstall(key: string, root: string, err: unknown, start: () => Promise<LspClient | null>) {
  installWaits.add(key);
  const until = Date.now() + tsInstallWait.maxMs;
  let ready = false;
  while (!ready && Date.now() < until) {
    await new Promise((r) => setTimeout(r, tsInstallWait.pollMs));
    ready = !(await tsInstallMissing(root));
  }
  installWaits.delete(key);
  if (!ready) {
    failed.add(key);
    lspState.status[key] = "error";
    lspState.message[key] = backendErrorText(err);
    ui.toast(t("code.lsp.startFailed", { kind: "typescript", err: String(err) }), "error");
    return;
  }
  if (await start()) for (const l of restartListeners) l();
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
  if (isForeignLang(file)) {
    const route = lspState.routes[file];
    if (route === "pending" || route === undefined) return null;
    if (route === "none") {
      for (const l of restartListeners) l(); // its editor tries again
      return null;
    }
  }
  file = shadowOf(file);
  const root = copies.get(file)?.root ?? (await findRoot(file, ROOT_MARKERS[kind], workspace));
  const key = `${kind}|${root}`;
  if (starting.has(key)) return starting.get(key)!;
  const pausable = PAUSABLE[kind];
  const by = pausable ? toolPausedBy(pausable.tool, pauseRootOf(root)) : null;
  if (pausable && by !== null) {
    // The host's explicit decision. It covers what it was asked about, not a change during the dialog.
    const seen = toolChangeCount(pausable.tool);
    if (!(await ui.confirm(t(pausable.title), t(pausable.msg, { name: by }), t(pausable.ok)))) return null;
    if (!resumeTool(pausable.tool, pauseRootOf(root), seen)) {
      serverHeld(kind, key, root);
      return null;
    }
  }
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

export interface WorkspaceSymbol {
  name: string;
  kind: number;
  containerName?: string;
  path: string;
  line: number;
  character: number;
}

/**
 * `workspace/symbol` from every running server, de-duplicated by location: two servers
 * (e.g. the project's and a std library rust-analyzer) can report the same symbol.
 */
export async function workspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
  const results = await Promise.all(allClients().map((c) => c.request("workspace/symbol", { query }, 4000).catch(() => [])));
  const seen = new Set<string>();
  const out: WorkspaceSymbol[] = [];
  for (const s of results.flatMap((r: Json) => (Array.isArray(r) ? r : []))) {
    const loc = s?.location;
    if (!loc?.uri) continue;
    const path = uriPath(loc.uri);
    const line = loc.range?.start?.line ?? 0, character = loc.range?.start?.character ?? 0;
    const key = `${path}:${s.name}:${line}:${character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: s.name, kind: s.kind, containerName: s.containerName, path, line, character });
  }
  return out;
}

export function statusFor(lang: LangInfo | null, file: string | null): { status: ServerStatus | null; message?: string } {
  if (!lang?.server || !file) return { status: null };
  if (isForeignLang(file)) {
    // Until it's known where this file goes, the project's server says nothing about it.
    const route = lspState.routes[file];
    if (route === "none") return { status: null };
    if (route === "pending" || route === undefined) return { status: "starting" };
  }
  file = shadowOf(file);
  // Find the client whose root contains the file (most specific).
  let best: string | null = null;
  for (const key of Object.keys(lspState.status)) {
    const [kind, root] = key.split("|");
    if (kind === lang.server && file.startsWith(root + "/") && (!best || root.length > best.split("|")[1].length)) best = key;
  }
  return best ? { status: lspState.status[best], message: lspState.message[best] } : { status: null };
}
