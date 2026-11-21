// Language servers of files set to another language: which server, and that nothing leaks.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

vi.mock("../ui.svelte", () => ({ ui: { toast: vi.fn(), confirm: vi.fn(async () => true), openMenu: vi.fn() } }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true, withInstallProgress: async (_i: string, _n: string, f: () => any) => f(), serverProgressId: (k: string) => k, mojoInstallHint: async () => null }));

let exists: Set<string>;
let calls: [string, any][];
let sent: any[];
let answerInit: boolean;
let L: typeof import("./lsp.svelte");
let O: typeof import("./langOverride.svelte");
let X: typeof import("./lspExtension");
let langs: typeof import("./languages");
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  localStorage.clear();
  exists = new Set();
  calls = [];
  sent = [];
  answerInit = true;
  mockIPC(
    (cmd, args: any) => {
      calls.push([cmd, args]);
      if (cmd === "path_exists") return exists.has(args.path);
      if (cmd === "read_file") return "int main(void) { return 0; }\n";
      if (cmd === "tools_dir") return "/tools";
      if (cmd === "which_cmd") return `/bin/${args.cmd.split("/").pop()}`;
      if (cmd === "cmd_works") return true;
      if (cmd === "lang_copy") return `/private/h/${args.part}/${args.name}`;
      if (cmd === "list_dir") return [];
      if (cmd === "proc_send") {
        const m = JSON.parse(args.msg);
        sent.push(m);
        if (m.id !== undefined && m.method && (m.method !== "initialize" || answerInit))
          setTimeout(() => emit("proc-msg", { id: args.id, msg: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { capabilities: {} } : null }) }), 0);
      }
      return null;
    },
    { shouldMockEvents: true },
  );
  vi.resetModules();
  L = await import("./lsp.svelte");
  O = await import("./langOverride.svelte");
  X = await import("./lspExtension");
  langs = await import("./languages");
  X.setLspHooks({ workspace: () => "/w", askInstall: async () => false, navigate: async () => {} });
  await settle();
});
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

const views: EditorView[] = [];
const lang = (id: string) => langs.langById(id)!;
const opened = () => sent.filter((m) => m.method === "textDocument/didOpen").map((m) => m.params.textDocument);
const spawned = () => calls.filter(([c]) => c === "proc_spawn").map(([, a]) => a);
function mount(path: string, id: Parameters<typeof O.setLanguageOverride>[1]) {
  O.setLanguageOverride(path, id);
  const info = O.effectiveLang(path)!;
  const v = new EditorView({ state: EditorState.create({ doc: "text", extensions: [X.lspExtension(path, info)] }), parent: document.body });
  views.push(v);
  return v;
}

describe("the document's lifetime", () => {
  async function running() {
    const copy = "/private/h/lsp/omega_main.c";
    L.registerShadow("/w/prog", copy);
    const c = (await L.clientFor(lang("c"), copy, "/w", async () => true))!;
    c.open(L.fileUri(copy), "c", "x");
    return { c, copy };
  }

  test("the server stops when the last tab on the copy closes", async () => {
    const { c, copy } = await running();
    L.closeLspDoc("/w/prog");
    expect(sent.some((m) => m.method === "textDocument/didClose" && m.params.textDocument.uri === L.fileUri(copy))).toBe(true);
    expect(sent.some((m) => m.method === "shutdown")).toBe(true);
    expect(c.stopping).toBe(true);
    expect(L.allClients()).toHaveLength(0);
    expect(L.realPathOf(copy)).toBe(copy);
  });

  test("a server still starting is stopped too", async () => {
    answerInit = false;
    const copy = "/private/h/lsp/omega_main.c";
    L.registerShadow("/w/prog", copy);
    void L.clientFor(lang("c"), copy, "/w", async () => true);
    await settle();
    expect(L.allClients()).toHaveLength(1);
    L.closeLspDoc("/w/prog");
    expect(calls.some(([c]) => c === "proc_kill")).toBe(true);
    expect(L.allClients()).toHaveLength(0);
  });

  test("a save refreshes the copy and reaches the server under its name", async () => {
    const { copy } = await running();
    await L.saveLspDoc("/w/prog", "new");
    expect(calls.find(([c]) => c === "lang_copy")![1]).toEqual({ file: "/w/prog", part: "lsp", name: "omega_main.c", link: false });
    expect(sent.find((m) => m.method === "textDocument/didSave").params.textDocument.uri).toBe(L.fileUri(copy));
  });
});

describe("which server", () => {
  test("an extensionless file set to Python in a uv project uses the project's server", async () => {
    exists.add("/w/pyproject.toml");
    mount("/w/tool", "python");
    await vi.waitFor(() => expect(opened()).toHaveLength(1));
    expect(opened()[0]).toMatchObject({ uri: "file:///w/tool", languageId: "python" });
    expect(spawned()[0].cwd).toBe("/w");
    expect(calls.some(([c]) => c === "lang_copy")).toBe(false);
  });

  test("Rust in a Cargo workspace uses the project's server", async () => {
    exists.add("/w/Cargo.toml");
    mount("/w/tool", "rust");
    await vi.waitFor(() => expect(opened()).toHaveLength(1));
    expect(opened()[0]).toMatchObject({ uri: "file:///w/tool", languageId: "rust" });
    expect(spawned()[0].cwd).toBe("/w");
  });

  test("C in a Python project works on the private copy", async () => {
    exists.add("/w/pyproject.toml");
    mount("/w/prog", "c");
    await vi.waitFor(() => expect(opened()).toHaveLength(1));
    expect(opened()[0]).toMatchObject({ uri: "file:///private/h/lsp/omega_main.c", languageId: "c" });
    expect(spawned()[0].cwd).toBe("/private/h/lsp");
  });

  test("C in a CMake project tells clangd the language before opening the real file", async () => {
    exists.add("/w/CMakeLists.txt");
    mount("/w/prog", "c");
    await vi.waitFor(() => expect(opened()).toHaveLength(1));
    const conf = sent.findIndex((m) => m.method === "workspace/didChangeConfiguration");
    expect(conf).toBeGreaterThanOrEqual(0);
    expect(conf).toBeLessThan(sent.findIndex((m) => m.method === "textDocument/didOpen"));
    expect(sent[conf].params.settings.compilationDatabaseChanges["/w/prog"].compilationCommand).toEqual(["clang", "-x", "c", "/w/prog"]);
  });
});

describe("status while the route is open", () => {
  test("shows starting, not the project's server", () => {
    L.lspState.status["clangd|/w"] = "ready";
    O.setLanguageOverride("/w/prog", "c");
    expect(L.statusFor(lang("c"), "/w/prog").status).toBe("starting");
    L.setLspRoute("/w/prog", "pending");
    expect(L.statusFor(lang("c"), "/w/prog").status).toBe("starting");
    L.setLspRoute("/w/prog", "project");
    expect(L.statusFor(lang("c"), "/w/prog").status).toBe("ready");
    L.setLspRoute("/w/prog", "none");
    expect(L.statusFor(lang("c"), "/w/prog").status).toBeNull();
    delete L.lspState.status["clangd|/w"];
  });

  test("restart doesn't start the project's server meanwhile", async () => {
    O.setLanguageOverride("/w/prog", "c");
    L.setLspRoute("/w/prog", "pending");
    expect(await L.restartServer(lang("c"), "/w/prog", "/w", async () => true)).toBeNull();
    expect(spawned()).toHaveLength(0);
  });
});
