/** Go to Declaration, Implementation and Type Definition: what the server answered, and the picker. */
import { basename, dirname } from "../api";
import type { MenuItem } from "../ui.svelte";

export const GOTO = {
  "lsp.gotoDeclaration": { method: "textDocument/declaration", capability: "declarationProvider" },
  "lsp.gotoImplementation": { method: "textDocument/implementation", capability: "implementationProvider" },
  "lsp.gotoTypeDefinition": { method: "textDocument/typeDefinition", capability: "typeDefinitionProvider" },
} as const;
export type GotoId = keyof typeof GOTO;
export const GOTO_IDS = Object.keys(GOTO) as GotoId[];

/** Entries in the picker; a type with more implementations than this gets a "more" row. */
export const MAX_PICKS = 50;

export interface GotoTarget {
  path: string;
  line: number;
  character: number;
}

const isPos = (p: any) => Number.isInteger(p?.line) && p.line >= 0 && Number.isInteger(p?.character) && p.character >= 0;

/**
 * The places in a `Location`, `Location[]` or `LocationLink[]` answer, once each. `toPath` turns a
 * URI into the real file, so a private copy's own path never reaches the user.
 */
export function gotoTargets(res: unknown, toPath: (uri: string) => string): GotoTarget[] {
  const seen = new Set<string>();
  const out: GotoTarget[] = [];
  for (const loc of (Array.isArray(res) ? res : res ? [res] : []) as any[]) {
    const uri = loc?.targetUri ?? loc?.uri;
    const start = (loc?.targetSelectionRange ?? loc?.targetRange ?? loc?.range)?.start;
    if (typeof uri !== "string" || !isPos(start)) continue;
    let path: string;
    try {
      path = toPath(uri);
    } catch {
      continue; // malformed percent-encoding: the other results are still good
    }
    const key = `${path}\0${start.line}\0${start.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, line: start.line, character: start.character });
  }
  return out;
}

/** Picker rows: file and line, with the folder on the right to tell equal names apart. */
export function pickerItems(targets: GotoTarget[], go: (t: GotoTarget) => void, more: (n: number) => string): MenuItem[] {
  const items: MenuItem[] = targets.slice(0, MAX_PICKS).map((target) => ({
    label: `${basename(target.path)}:${target.line + 1}`,
    shortcut: basename(dirname(target.path)),
    title: target.path,
    action: () => go(target),
  }));
  if (targets.length > MAX_PICKS) items.push({ label: more(targets.length - MAX_PICKS), disabled: true });
  return items;
}
