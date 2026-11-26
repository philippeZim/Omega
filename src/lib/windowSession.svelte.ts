// A window's start and its session: the tabs it had open come back, and what the backend asked it
// to open (`omega <folder|file>`, a restored window) is opened here.
import { invoke } from "@tauri-apps/api/core";
import { fsApi } from "./api";
import { activate, app, flushAutosave, openFile, setGroups, setMode, setRoot, unsavedTabs } from "./state.svelte";
import { FIRST_GROUP, saveLayout, type Groups, type LayoutNode, type SavedLayout, type SavedNode } from "./editorGroups";
import { handsOverFolder, keepsSession, parseSession, sessionOf, type Session } from "./windowSessionData";
import type { Mode } from "./modes";
import { listen } from "./windowEvents";
import { pruneWindows, unscopedStorage } from "./windowStorage";

const KEY = "session";

async function restoreTabs(saved: Session) {
  // Opening a file switches to its mode; the window comes back in the mode it was in.
  const mode = app.mode as Mode;
  for (const f of saved.files) if (await fsApi.exists(f).catch(() => false)) await openFile(f, true);
  if (saved.layout && restoreGroups(saved.layout)) return;
  const active = app.tabs.find((t) => (t.path ?? t.viewOf) === saved.active);
  if (active) activate(active.id);
  if (app.mode !== mode) setMode(mode);
}

const tabOfFile = (f: string) => app.tabs.find((t) => (t.path ?? t.viewOf ?? t.headOf) === f)?.id ?? null;

/** Rebuilds the saved editor groups from the tabs just opened. False if nothing of it is left. */
function restoreGroups(saved: SavedLayout): boolean {
  const ids = saved.groups.map((_, i) => (i === 0 ? FIRST_GROUP : `g${Math.random().toString(36).slice(2, 10)}`));
  const groups: Groups["groups"] = {};
  saved.groups.forEach((sg, i) => {
    const tabs = [...new Set(sg.files.map(tabOfFile).filter((x): x is string => !!x))];
    const modes: Record<string, Mode> = {};
    for (const [f, m] of Object.entries(sg.modes)) {
      const id = tabOfFile(f);
      if (id && tabs.includes(id)) modes[id] = m;
    }
    const a = sg.active ? tabOfFile(sg.active) : null;
    groups[ids[i]] = { id: ids[i], tabs, active: a && tabs.includes(a) ? a : (tabs[0] ?? null), modes };
  });
  // Groups whose files are all gone are left out.
  const keep = (id: string) => groups[id].tabs.length > 0;
  const build = (n: SavedNode): LayoutNode | null => {
    if ("group" in n) return keep(ids[n.group]) ? { group: ids[n.group] } : null;
    const kids = n.children.map((c, i) => [build(c), n.sizes[i]] as const).filter((x): x is readonly [LayoutNode, number] => !!x[0]);
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0][0];
    const sum = kids.reduce((a, k) => a + k[1], 0);
    return { dir: n.dir, children: kids.map((k) => k[0]), sizes: kids.map((k) => k[1] / sum) };
  };
  const root = build(saved.root);
  if (!root || "group" in root) return false;
  const live = Object.fromEntries(Object.entries(groups).filter(([id]) => keep(id)));
  // The first group's editor pane already exists; it must stay part of the layout.
  if (!(FIRST_GROUP in live)) {
    const first = Object.keys(live)[0];
    live[FIRST_GROUP] = { ...live[first], id: FIRST_GROUP };
    delete live[first];
    const rename = (n: LayoutNode): LayoutNode => ("group" in n ? (n.group === first ? { group: FIRST_GROUP } : n) : { ...n, children: n.children.map(rename) });
    return apply(rename(root), live, ids[saved.focused] === first ? FIRST_GROUP : ids[saved.focused]);
  }
  return apply(root, live, ids[saved.focused]);
}

function apply(root: LayoutNode, groups: Groups["groups"], focused: string): boolean {
  setGroups({ root, groups, focused: focused in groups ? focused : FIRST_GROUP });
  return true;
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
      const session: Session = sessionOf(app.tabs.map((t) => ({ id: t.id, path: t.path ?? t.viewOf })), app.activeId);
      const pathOf = (id: string) => {
        const p = app.tabs.find((t) => t.id === id);
        const f = p?.path ?? p?.viewOf ?? null;
        return f && session.files.includes(f) ? f : null;
      };
      const layout = saveLayout(app.groups, pathOf);
      const text = JSON.stringify(layout ? { ...session, layout } : session);
      try {
        localStorage.setItem(KEY, text);
      } catch {}
    });
  });
}
