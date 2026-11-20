import { dirname, joinPath } from "./api";

/**
 * Checks a name typed for a file or folder. With `nested` (New File), "sub/x.txt" is fine and
 * creates the folders in between; without it (Rename), the name must be a single part. Either way
 * nothing may leave the folder (".." or a leading "/") or name nothing (empty parts, ".").
 */
export function validEntryName(name: string, nested = false): boolean {
  const parts = name.split(/[\\/]/);
  if (!nested && parts.length > 1) return false;
  return !parts.some((seg) => seg === "" || seg === "." || seg === "..");
}

/** Target path when renaming `path` to `name`, or null if the name is invalid (#90). */
export function renameTarget(path: string, name: string): string | null {
  return validEntryName(name) ? joinPath(dirname(path), name) : null;
}
