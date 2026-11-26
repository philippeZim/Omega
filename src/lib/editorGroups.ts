// Editor groups (#219): the editor area is a tree of splits whose leaves are groups. Each group has
// its own tabs, its active tab and the mode each of its tabs is shown in. A document (an entry of
// `app.tabs`) can be in several groups. Pure data, no app imports, so it stays testable on its own.
import type { Mode } from "./modeList";

export interface Group {
  id: string;
  /** Document ids (`Tab.id`) in tab bar order. */
  tabs: string[];
  active: string | null;
  /** The mode each tab is shown in here; the same file may show as Markdown in one group and as Code in another. */
  modes: Record<string, Mode>;
}

export type Dir = "row" | "col";
export type LayoutNode = { group: string } | { dir: Dir; children: LayoutNode[]; sizes: number[] };
export type Side = "left" | "right" | "up" | "down";

export interface Groups {
  groups: Record<string, Group>;
  root: LayoutNode;
  focused: string;
}

/** The first group's id; its editor pane is the one that exists without any split. */
export const FIRST_GROUP = "main";

export const emptyGroup = (id: string): Group => ({ id, tabs: [], active: null, modes: {} });

export function initialGroups(): Groups {
  return { groups: { [FIRST_GROUP]: emptyGroup(FIRST_GROUP) }, root: { group: FIRST_GROUP }, focused: FIRST_GROUP };
}

const isLeaf = (n: LayoutNode): n is { group: string } => "group" in n;

/** Group ids in reading order (left to right, top to bottom). */
export function groupOrder(n: LayoutNode): string[] {
  return isLeaf(n) ? [n.group] : n.children.flatMap(groupOrder);
}

const sideDir = (s: Side): Dir => (s === "left" || s === "right" ? "row" : "col");
const before = (s: Side) => s === "left" || s === "up";

/** Puts the new group `id` next to group `at`, splitting it in half. */
export function splitAt(root: LayoutNode, at: string, side: Side, id: string): LayoutNode {
  const dir = sideDir(side);
  const leaf = { group: id };
  const walk = (n: LayoutNode): LayoutNode => {
    if (isLeaf(n)) {
      if (n.group !== at) return n;
      return { dir, children: before(side) ? [leaf, n] : [n, leaf], sizes: [0.5, 0.5] };
    }
    const i = n.children.findIndex((c) => isLeaf(c) && c.group === at);
    if (i >= 0 && n.dir === dir) {
      // Same direction: a sibling, sharing the space of the split one.
      const children = [...n.children];
      const sizes = [...n.sizes];
      const half = sizes[i] / 2;
      sizes[i] = half;
      const j = before(side) ? i : i + 1;
      children.splice(j, 0, leaf);
      sizes.splice(j, 0, half);
      return { dir, children, sizes };
    }
    return { ...n, children: n.children.map(walk) };
  };
  return walk(root);
}

/** Removes group `id` from the tree; a split left with one child becomes that child. */
export function removeFrom(root: LayoutNode, id: string): LayoutNode {
  const walk = (n: LayoutNode): LayoutNode | null => {
    if (isLeaf(n)) return n.group === id ? null : n;
    const kept: LayoutNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((c, i) => {
      const w = walk(c);
      if (!w) return;
      // A child split in the same direction merges into this one.
      if (!isLeaf(w) && w.dir === n.dir) {
        w.children.forEach((cc, k) => {
          kept.push(cc);
          sizes.push(n.sizes[i] * w.sizes[k]);
        });
      } else {
        kept.push(w);
        sizes.push(n.sizes[i]);
      }
    });
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0];
    const sum = sizes.reduce((a, b) => a + b, 0) || 1;
    return { dir: n.dir, children: kept, sizes: sizes.map((s) => s / sum) };
  };
  return walk(root) ?? { group: FIRST_GROUP };
}

/** The group next to `id` in reading order, the one before if it's the last; null if alone. */
export function neighbour(root: LayoutNode, id: string): string | null {
  const order = groupOrder(root);
  const i = order.indexOf(id);
  if (order.length < 2 || i < 0) return null;
  return order[i + 1] ?? order[i - 1];
}

/** Where a tab closed in a group hands over: the tab after it, else the one before. */
export function nextActive(tabs: string[], closed: string): string | null {
  const i = tabs.indexOf(closed);
  if (i < 0) return tabs[0] ?? null;
  return tabs[i + 1] ?? tabs[i - 1] ?? null;
}

// ------------------------------------------------------------------ session

/** A group as saved: files instead of tab ids. */
export interface SavedGroup {
  files: string[];
  active: string | null;
  modes: Record<string, Mode>;
}
export type SavedNode = { group: number } | { dir: Dir; children: SavedNode[]; sizes: number[] };
export interface SavedLayout {
  root: SavedNode;
  groups: SavedGroup[];
  focused: number;
}

const MODES_OK = new Set(["text", "markdown", "latex", "code"]);

/** Checks a saved layout; anything malformed gives null (the window then starts with one group). */
export function parseLayout(raw: unknown): SavedLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (!Array.isArray(v.groups) || !v.groups.length || v.groups.length > 16) return null;
  const groups: SavedGroup[] = [];
  for (const g of v.groups) {
    if (!g || typeof g !== "object" || !Array.isArray(g.files)) return null;
    const files = g.files.filter((f: unknown): f is string => typeof f === "string");
    const modes: Record<string, Mode> = {};
    if (g.modes && typeof g.modes === "object")
      for (const [k, m] of Object.entries(g.modes)) if (typeof m === "string" && MODES_OK.has(m)) modes[k] = m as Mode;
    groups.push({ files, active: typeof g.active === "string" ? g.active : null, modes });
  }
  const seen = new Set<number>();
  const node = (n: unknown, depth: number): SavedNode | null => {
    if (!n || typeof n !== "object" || depth > 8) return null;
    const o = n as Record<string, unknown>;
    if (typeof o.group === "number") {
      if (!Number.isInteger(o.group) || o.group < 0 || o.group >= groups.length || seen.has(o.group)) return null;
      seen.add(o.group);
      return { group: o.group };
    }
    if ((o.dir !== "row" && o.dir !== "col") || !Array.isArray(o.children) || o.children.length < 2) return null;
    const children = o.children.map((c) => node(c, depth + 1));
    if (children.some((c) => !c)) return null;
    const sizes = Array.isArray(o.sizes) && o.sizes.length === children.length && o.sizes.every((s) => typeof s === "number" && s > 0) ? (o.sizes as number[]) : children.map(() => 1);
    const sum = sizes.reduce((a, b) => a + b, 0);
    return { dir: o.dir, children: children as SavedNode[], sizes: sizes.map((s) => s / sum) };
  };
  const root = node(v.root, 0);
  if (!root || seen.size !== groups.length) return null;
  const focused = typeof v.focused === "number" && v.focused >= 0 && v.focused < groups.length ? v.focused : 0;
  return { root, groups, focused };
}

/** The layout to save; `pathOf` gives a tab's file (null = not saved: unsaved, shared …). */
export function saveLayout(g: Groups, pathOf: (id: string) => string | null): SavedLayout | null {
  const order = groupOrder(g.root);
  if (order.length < 2) return null;
  const index = new Map(order.map((id, i) => [id, i]));
  const node = (n: LayoutNode): SavedNode => (isLeaf(n) ? { group: index.get(n.group)! } : { dir: n.dir, children: n.children.map(node), sizes: n.sizes });
  const groups = order.map((id) => {
    const grp = g.groups[id];
    const files: string[] = [];
    const modes: Record<string, Mode> = {};
    for (const t of grp.tabs) {
      const p = pathOf(t);
      if (!p || files.includes(p)) continue;
      files.push(p);
      if (grp.modes[t]) modes[p] = grp.modes[t];
    }
    const a = grp.active ? pathOf(grp.active) : null;
    return { files, active: a && files.includes(a) ? a : null, modes };
  });
  return { root: node(g.root), groups, focused: index.get(g.focused) ?? 0 };
}
