// What a window's session holds (no app imports, so it stays testable on its own).
import { parseLayout, type SavedLayout } from "./editorGroups";

export interface Session {
  files: string[];
  active: string | null;
  /** Split editor groups (#219); absent with one group. */
  layout?: SavedLayout | null;
}

/** What survives a restart: tabs with a file on this machine (no unsaved or shared ones). */
export function sessionOf(tabs: { id: string; path?: string | null }[], activeId: string | null): Session {
  const files = tabs.flatMap((t) => (t.path && !t.path.startsWith("collab:") ? [t.path] : []));
  const active = tabs.find((t) => t.id === activeId)?.path ?? null;
  return { files, active: active && files.includes(active) ? active : null };
}

/**
 * A window told to open another folder doesn't bring back the tabs of the one it had. Loose files
 * of a window without a folder stay: there was no other project they belonged to.
 */
export const keepsSession = (bootRoot: string | null | undefined, savedRoot: string | null, guestSnapshot: boolean) => !guestSnapshot && (!bootRoot || !savedRoot || bootRoot === savedRoot);

/**
 * The backend only offers a window it believes is empty (`ifEmpty`), but it can't see a workspace
 * just taken over from an old profile. Such a window keeps it, and the folder gets its own window.
 */
export const handsOverFolder = (ifEmpty: boolean | undefined, bootRoot: string | null | undefined, savedRoot: string | null) => !!ifEmpty && !!bootRoot && !!savedRoot && bootRoot !== savedRoot;

export function parseSession(text: string | null): Session | null {
  try {
    const v = JSON.parse(text ?? "null");
    if (!v || !Array.isArray(v.files)) return null;
    const layout = parseLayout(v.layout);
    return { files: v.files.filter((f: unknown): f is string => typeof f === "string"), active: typeof v.active === "string" ? v.active : null, ...(layout ? { layout } : {}) };
  } catch {
    return null;
  }
}
