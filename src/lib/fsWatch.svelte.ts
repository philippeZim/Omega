/** Live explorer: the Rust side watches the open folder and reports which directories changed. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "./windowEvents";

/**
 * Bumped per batch. `dirs`: directories whose listing changed; `files`: files created, removed,
 * renamed or modified (normalized paths).
 */
export const fsChanges = $state({ seq: 0, dirs: [] as string[], files: [] as string[] });

const fileListeners = new Set<(files: string[]) => void>();
/** For non-component consumers (e.g. the LaTeX controller). */
export function onFilesChanged(fn: (files: string[]) => void) {
  fileListeners.add(fn);
  return () => fileListeners.delete(fn);
}

listen<{ dirs: string[]; files: string[] }>("fs-changed", ({ payload }) => {
  fsChanges.dirs = payload.dirs;
  fsChanges.files = payload.files;
  fsChanges.seq++;
  for (const fn of fileListeners) fn(payload.files);
});

export function watchRoot(dir: string | null) {
  invoke("watch_dir", { path: dir }).catch((e) => console.warn("watch_dir:", e));
}
