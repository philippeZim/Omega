// Reusable fakes for module mocks (vi.mock factories) and the Tauri IPC.
import { vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

type Callbacks = { onDirty(id: string, dirty: boolean): void; onCursor(...a: number[]): void; onChange(id: string): void };

/**
 * Stand-in for src/lib/editor.ts: per-tab current text and saved text, nothing else. Like
 * CodeMirror, documents only hold "\n" line breaks.
 */
export function fakeEditor() {
  const docs = new Map<string, { text: string; saved: string }>();
  let cb: Callbacks | null = null;
  const norm = (s: string) => s.replace(/\r\n?/g, "\n");
  const self = {
    docs,
    /** Documents are gone (e.g. after an editor reset) while the tab still exists. */
    dropLive: false,
    setCallbacks: (c: Callbacks) => void (cb = c),
    setKeyHandler: () => {},
    createDoc: (id: string, content: string) => void docs.set(id, { text: norm(content), saved: norm(content) }),
    disposeDoc: (id: string) => void docs.delete(id),
    activate: vi.fn(),
    configure: vi.fn(),
    clearDiagnostics: vi.fn(),
    getView: () => null,
    getText: (id: string) => docs.get(id)?.text ?? "",
    getDoc: (id: string) => {
      const d = docs.get(id);
      if (!d || self.dropLive) return null;
      const snap = d.text;
      return { toString: () => snap };
    },
    markSaved: (id: string, doc?: { toString(): string }) => {
      const d = docs.get(id);
      if (d) d.saved = doc ? doc.toString() : d.text;
    },
    savedText: (id: string) => docs.get(id)?.saved ?? null,
    isDirty: (id: string) => {
      const d = docs.get(id);
      return !!d && d.text !== d.saved;
    },
    replaceDocText: (id: string, text: string) => self.type(id, text),
    /** Mocked modules survive vi.resetModules(); call this per test. */
    reset: () => {
      docs.clear();
      cb = null;
      self.dropLive = false;
      for (const f of [self.activate, self.configure, self.clearDiagnostics]) f.mockClear();
    },
    /** Test helper: the user changes the whole text (fires onDirty like the real editor). */
    type: (id: string, text: string) => {
      const d = docs.get(id);
      if (!d || d.text === text) return;
      d.text = text;
      cb?.onDirty(id, d.text !== d.saved);
      cb?.onChange(id);
    },
  };
  return self;
}
export type FakeEditor = ReturnType<typeof fakeEditor>;

/** Stand-in for src/lib/ui.svelte.ts `ui`. `choose` resolves via `answer()` (FIFO), or to `nextChoice`. */
export function fakeUi() {
  const pending: ((v: string | null) => void)[] = [];
  const ui = {
    toasts: [] as { text: string; kind: string }[],
    help: false,
    /** If set, choose() resolves immediately with this value. */
    nextChoice: undefined as string | null | undefined,
    toast: vi.fn((text: string, kind: string = "info") => void ui.toasts.push({ text, kind })),
    choose: vi.fn((_title: string, _msg: string, _opts: unknown[]) =>
      ui.nextChoice !== undefined ? Promise.resolve(ui.nextChoice) : new Promise<string | null>((r) => pending.push(r)),
    ),
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => null as string | null),
    openMenu: vi.fn(),
    reset: () => {
      pending.length = 0;
      ui.toasts = [];
      ui.nextChoice = undefined;
      for (const f of [ui.toast, ui.choose, ui.confirm, ui.prompt, ui.openMenu]) f.mockClear();
    },
    /** Answers the oldest open choose() dialog. */
    answer: (v: string | null) => pending.shift()?.(v),
    get open() {
      return pending.length;
    },
  };
  return ui;
}
export type FakeUi = ReturnType<typeof fakeUi>;

/**
 * In-memory file system behind mockIPC (read_file, write_file, create_file, create_dir,
 * path_exists, list_dir; folders exist implicitly as prefixes of file paths). `calls` records every invoke; `failWrite` makes write_file reject.
 */
export function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs = {
    files,
    calls: [] as { cmd: string; args: any }[],
    failWrite: null as string | null,
    /** Awaited before read_file / write_file touch the map (to hold an operation open). */
    beforeRead: (_path: string): Promise<void> | void => {},
    beforeWrite: (_path: string): Promise<void> | void => {},
    /** Called for commands the fake doesn't know. */
    other: (_cmd: string, _args: any): unknown => null,
  };
  mockIPC(
    async (cmd, args: any) => {
      fs.calls.push({ cmd, args });
      switch (cmd) {
        case "read_file":
          await fs.beforeRead(args.path);
          if (!files.has(args.path)) throw `not found: ${args.path}`;
          return files.get(args.path);
        case "write_file":
          await fs.beforeWrite(args.path);
          if (fs.failWrite) throw fs.failWrite;
          files.set(args.path, args.content);
          return null;
        case "create_file":
          if (files.has(args.path)) throw `File exists (os error 17)`;
          files.set(args.path, "");
          return null;
        case "create_dir":
          return null;
        case "path_exists":
          return files.has(args.path) || [...files.keys()].some((f) => f.startsWith(args.path + "/"));
        case "list_dir": {
          // Folders exist implicitly as prefixes of file paths.
          const pre = args.path + "/";
          const kids = [...files.keys()].filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length).split("/")[0]);
          if (!kids.length) throw files.has(args.path) ? "Not a directory (os error 20)" : `not found: ${args.path}`;
          return [...new Set(kids)].map((name) => ({ name, path: pre + name, is_dir: files.has(pre + name) === false }));
        }
        default:
          return fs.other(cmd, args);
      }
    },
    { shouldMockEvents: true },
  );
  return fs;
}
export type FakeFs = ReturnType<typeof fakeFs>;

/** A promise plus its resolve function. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets pending promise chains (several awaits deep) settle. */
export async function flush(n = 50) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
