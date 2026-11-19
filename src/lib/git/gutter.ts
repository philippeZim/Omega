/** Git change markers in the gutter (added / modified / deleted vs. HEAD), PyCharm-style. */
import { RangeSet, StateEffect, StateField, Text, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import { Chunk } from "@codemirror/merge";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/index.svelte";

type Kind = "added" | "modified" | "deleted";

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: Kind) {
    super();
  }
  eq(o: ChangeMarker) {
    return o.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-git-${this.kind}`;
    return el;
  }
}

const setHead = StateEffect.define<Text | null>();

interface GitData {
  head: Text | null;
  chunks: readonly Chunk[];
}

function computeChunks(head: Text | null, doc: Text): readonly Chunk[] {
  if (!head) return [];
  try {
    return Chunk.build(head, doc, { scanLimit: 5000 });
  } catch {
    return [];
  }
}

const gitData = StateField.define<GitData>({
  create: () => ({ head: null, chunks: [] }),
  update(v, tr) {
    let head = v.head;
    for (const e of tr.effects) if (e.is(setHead)) head = e.value;
    if (head === v.head && !tr.docChanged) return v;
    return { head, chunks: computeChunks(head, tr.state.doc) };
  },
});

function markers(view: EditorView) {
  const data = view.state.field(gitData, false);
  if (!data?.head) return RangeSet.empty;
  const doc = view.state.doc;
  const out = [];
  for (const c of data.chunks) {
    const kind: Kind = c.fromA === c.toA ? "added" : c.fromB === c.toB ? "deleted" : "modified";
    if (kind === "deleted") {
      out.push(new ChangeMarker("deleted").range(doc.lineAt(Math.min(c.fromB, doc.length)).from));
      continue;
    }
    const first = doc.lineAt(Math.min(c.fromB, doc.length)).number;
    const last = doc.lineAt(Math.max(c.fromB, Math.min(c.toB, doc.length) - 1)).number;
    for (let l = first; l <= last; l++) out.push(new ChangeMarker(kind).range(doc.line(l).from));
  }
  return RangeSet.of(out, true);
}

// ------------------------------------------------------------------ app hooks

let hooks = {
  root: () => null as string | null,
  menu: (_e: MouseEvent, _items: { label: string; action: () => void; danger?: boolean }[]) => {},
  showDiff: (_path: string) => {},
};
export function setGitGutterHooks(h: typeof hooks) {
  hooks = h;
}

/** Views to refresh when HEAD changes (commit, pull, branch switch). */
const live = new Set<{ reload: () => void }>();
export function reloadGitHeads() {
  for (const p of live) p.reload();
}

export function gitGutter(path: string): Extension {
  const loader = ViewPlugin.fromClass(
    class {
      alive = true;
      constructor(readonly view: EditorView) {
        live.add(this);
        this.reload();
      }
      async reload() {
        const root = hooks.root();
        if (!root) return;
        const text = await invoke<string | null>("git_head_file", { root, path }).catch(() => null);
        if (!this.alive) return;
        // New (untracked) files: no markers, like PyCharm colours the whole file name instead.
        this.view.dispatch({ effects: setHead.of(text === null ? null : Text.of(text.split("\n"))) });
      }
      destroy() {
        this.alive = false;
        live.delete(this);
      }
    },
  );

  return [
    gitData,
    loader,
    gutter({
      class: "cm-git-gutter",
      markers,
      domEventHandlers: {
        mousedown(view, line, e) {
          const data = view.state.field(gitData, false);
          if (!data?.head) return false;
          const head = data.head;
          const chunk = data.chunks.find((c) => line.from >= view.state.doc.lineAt(Math.min(c.fromB, view.state.doc.length)).from && line.from <= Math.max(c.fromB, Math.min(c.toB, view.state.doc.length)));
          if (!chunk) return false;
          hooks.menu(e as MouseEvent, [
            {
              label: t("git.revertChange"),
              danger: true,
              action: () => {
                const doc = view.state.doc;
                const to = Math.min(chunk.toB, doc.length);
                const original = head.sliceString(chunk.fromA, Math.min(chunk.toA, head.length));
                view.dispatch({ changes: { from: chunk.fromB, to, insert: chunk.toB > doc.length && original.endsWith("\n") ? original.slice(0, -1) : original } });
              },
            },
            { label: t("git.showDiff"), action: () => hooks.showDiff(path) },
          ]);
          return true;
        },
      },
    }),
    EditorView.baseTheme({
      ".cm-git-gutter": { width: "5px", marginRight: "2px" },
      ".cm-git-gutter .cm-gutterElement": { padding: "0", cursor: "pointer" },
      ".cm-git-added, .cm-git-modified": { width: "3px", height: "100%", borderRadius: "2px" },
      ".cm-git-added": { background: "#7bbf8e" },
      ".cm-git-modified": { background: "#6b9be0" },
      ".cm-git-deleted": { width: "0", height: "0", borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "5px solid #df7067", marginTop: "-4px" },
    }),
  ];
}
