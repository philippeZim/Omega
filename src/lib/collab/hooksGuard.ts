/**
 * Code Together: a guest with `edit` but without `run` must not get code run on the host through git
 * hooks. Host side: which paths are the repository's effective hooks (collab_hooks_check resolves
 * them), failing closed when that can't be determined. Guests with `run` may run code anyway.
 */
import { invoke } from "@tauri-apps/api/core";
import { hasCapability } from "./rpc.svelte";

export interface HooksCheck {
  ok: boolean;
  /** The hooks live in the shared folder, so replacing its files can change them. */
  inProject: boolean;
  /** Per path: inside the hooks. */
  locked: boolean[];
  /** Per path: inside the hooks, or a folder holding them (moving or deleting it replaces them). */
  structural: boolean[];
}

const closed = (n: number): HooksCheck => ({ ok: false, inProject: true, locked: Array(n).fill(true), structural: Array(n).fill(true) });

export async function hooksCheck(root: string, rels: string[]): Promise<HooksCheck> {
  try {
    const c = await invoke<HooksCheck | null>("collab_hooks_check", { root, paths: rels.map((r) => `${root}/${r}`) });
    return c?.ok === true && c.locked?.length === rels.length && c.structural?.length === rels.length ? c : closed(rels.length);
  } catch {
    return closed(rels.length);
  }
}

/** Fresh check for a write a guest asked for. `structural`: it moves or deletes the path. */
export async function guestMayWrite(peer: string, root: string, rels: string[], structural = false) {
  if (hasCapability(peer, "run")) return true;
  const c = await hooksCheck(root, rels);
  return c.ok && !(structural ? c.structural : c.locked).some(Boolean);
}

/** Whether replacing files across the repository could change hooks this guest may not change. */
export async function hooksBlockReplace(peer: string, root: string) {
  if (hasCapability(peer, "run")) return false;
  const c = await hooksCheck(root, []);
  return !c.ok || c.inProject;
}

// Keystrokes are applied in order and synchronously, so shared docs use a cached answer per file.
let cache = { root: "", known: new Map<string, { locked: boolean; id: number }>() };
let nextCheck = 0;

/** Re-checks these docs. Returns those whose answer changed. */
export async function refreshHookLocks(root: string, rels: string[]): Promise<string[]> {
  const files = rels.filter((r) => !r.startsWith("tab:"));
  const id = ++nextCheck;
  const target = cache.root === root ? cache : (cache = { root, known: new Map() });
  const c = await hooksCheck(root, files);
  if (cache !== target) return []; // another folder or session meanwhile
  const changed: string[] = [];
  files.forEach((rel, i) => {
    const was = target.known.get(rel);
    if (was && was.id > id) return; // a check started later already answered
    if (was && was.locked !== c.locked[i]) changed.push(rel);
    target.known.set(rel, { locked: c.locked[i], id });
  });
  return changed;
}

/** For a doc edit: anything not known to be safe is refused for a guest without `run`. */
export function hookLocked(peer: string, root: string | null, rel: string) {
  if (rel.startsWith("tab:") || hasCapability(peer, "run")) return false;
  return !root || cache.root !== root || cache.known.get(rel)?.locked !== false;
}

export function resetHookLocks() {
  cache = { root: "", known: new Map() };
}
