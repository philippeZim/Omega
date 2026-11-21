// A window's start and its session: the tabs it had open come back, and what the backend asked it
// to open (`omega <folder|file>`, a restored window) is opened here.
import { invoke } from "@tauri-apps/api/core";
import { fsApi } from "./api";
import { activate, app, flushAutosave, openFile, setMode, setRoot, unsavedTabs } from "./state.svelte";
import { handsOverFolder, keepsSession, parseSession, sessionOf, type Session } from "./windowSessionData";
import type { Mode } from "./modes";
import { listen } from "./windowEvents";
import { pruneWindows, unscopedStorage } from "./windowStorage";

const KEY = "session";

async function restoreTabs(saved: Session) {
  // Opening a file switches to its mode; the window comes back in the mode it was in.
  const mode = app.mode as Mode;
  for (const f of saved.files) if (await fsApi.exists(f).catch(() => false)) await openFile(f);
  const active = app.tabs.find((t) => t.path === saved.active);
  if (active) activate(active.id);
  if (app.mode !== mode) setMode(mode);
}

const prune = (open: string[]) => pruneWindows(unscopedStorage(), open);

let booted = false;

export async function bootWindow() {
  if (booted) return;
  booted = true;
  listen<number>("window-unsaved-query", async (e) => {
    await flushAutosave().catch(() => {});
    void invoke("window_unsaved_reply", { call: e.payload, count: unsavedTabs().length });
  });
  listen("windows-changed", () => void invoke<string[]>("window_labels").then(prune).catch(() => {}));

  listen<{ root: string | null; files: string[] }>("window-open", async ({ payload }) => {
    if (payload.root) setRoot(payload.root);
    for (const f of payload.files) await openFile(f);
  });

  const boot = await invoke<{ root: string | null; files: string[]; ifEmpty?: boolean; windows: string[] }>("window_boot").catch(() => null);
  if (boot?.windows?.length) prune(boot.windows);
  const savedRoot = app.root;
  const handOver = handsOverFolder(boot?.ifEmpty, boot?.root, savedRoot);
  const root = handOver ? null : boot?.root;
  if (root) setRoot(root);
  // A workspace put aside for a Code Together session is brought back by the session code.
  const saved = keepsSession(root, savedRoot, !!localStorage.getItem("collab.guestSnapshot")) ? parseSession(localStorage.getItem(KEY)) : null;
  if (saved) await restoreTabs(saved);
  if (handOver) void invoke("window_open_paths", { root: boot!.root, files: boot!.files }).catch(() => {});
  else for (const f of boot?.files ?? []) await openFile(f);

  // Saved from here on, so the empty start can't overwrite the session.
  $effect.root(() => {
    $effect(() => {
      const text = JSON.stringify(sessionOf(app.tabs.map((t) => ({ id: t.id, path: t.path })), app.activeId));
      try {
        localStorage.setItem(KEY, text);
      } catch {}
    });
  });
}
