// What a window's session holds (no app imports, so it stays testable on its own).
export interface Session {
  files: string[];
  active: string | null;
}

/** What survives a restart: tabs with a file on this machine (no unsaved or shared ones). */
export function sessionOf(tabs: { id: string; path?: string | null }[], activeId: string | null): Session {
  const files = tabs.flatMap((t) => (t.path && !t.path.startsWith("collab:") ? [t.path] : []));
  const active = tabs.find((t) => t.id === activeId)?.path ?? null;
  return { files, active: active && files.includes(active) ? active : null };
}

export function parseSession(text: string | null): Session | null {
  try {
    const v = JSON.parse(text ?? "null");
    if (!v || !Array.isArray(v.files)) return null;
    return { files: v.files.filter((f: unknown): f is string => typeof f === "string"), active: typeof v.active === "string" ? v.active : null };
  } catch {
    return null;
  }
}
