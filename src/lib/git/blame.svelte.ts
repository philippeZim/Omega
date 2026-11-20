/**
 * Git blame annotations in the gutter (PyCharm "Annotate with Git Blame"): date and author of
 * the last change for every line, details on hover. Optional, toggled in Settings → Code.
 */
import { Compartment, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n/index.svelte";

interface Commit {
  hash: string;
  author: string;
  mail: string;
  time: number;
  summary: string;
}
interface Blame {
  commits: Commit[];
  lines: number[];
}
/** Per document line: the commit that last touched it, or null (changed / not committed yet). */
type Lines = (Commit | null)[];

export const blameSettings = $state({ enabled: localStorage.getItem("gitBlame") === "true" });

export function setGitBlame(on: boolean) {
  blameSettings.enabled = on;
  localStorage.setItem("gitBlame", String(on));
  for (const p of live) p.reload();
}

let rootHook: () => string | null = () => null;
export function setBlameRoot(fn: () => string | null) {
  rootHook = fn;
}

const live = new Set<{ reload: () => void }>();
/** Re-blames all open editors (after commit, pull, branch switch, save). */
export function reloadBlame() {
  for (const p of live) p.reload();
}

const setBlame = StateEffect.define<Lines | null>();

const blameField = StateField.define<Lines | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value;
    if (!v || !tr.docChanged) return v;
    // Shift the annotations with the edit until the next blame arrives; edited lines lose theirs.
    const a = tr.startState.doc;
    const b = tr.state.doc;
    const out: Lines = [];
    let posA = 1;
    tr.changes.iterChanges((fA, tA, _fB, tB) => {
      const la1 = a.lineAt(fA).number;
      const la2 = a.lineAt(tA).number;
      for (let l = posA; l < la1; l++) out.push(v[l - 1] ?? null);
      for (let l = out.length + 1; l <= b.lineAt(tB).number; l++) out.push(null);
      posA = Math.max(posA, la2 + 1);
    });
    for (let l = posA; l <= a.lines; l++) out.push(v[l - 1] ?? null);
    return out;
  },
});

const fmtDate = (s: number) => new Date(s * 1000).toLocaleDateString(i18n.locale, { year: "numeric", month: "2-digit", day: "2-digit" });

class BlameMarker extends GutterMarker {
  constructor(readonly c: Commit, readonly age: number) {
    super();
  }
  eq(o: BlameMarker) {
    return o.c === this.c && o.age === this.age;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-blame";
    el.style.setProperty("--blame-age", String(this.age));
    const d = document.createElement("span");
    d.className = "cm-blame-date";
    d.textContent = fmtDate(this.c.time);
    const a = document.createElement("span");
    a.className = "cm-blame-author";
    a.textContent = this.c.author;
    el.append(d, a);
    const when = new Date(this.c.time * 1000).toLocaleString(i18n.locale);
    el.title = `${this.c.hash.slice(0, 8)} · ${this.c.author}${this.c.mail ? ` <${this.c.mail}>` : ""}\n${when}\n\n${this.c.summary}`;
    return el;
  }
}

/** Keeps the column width stable (no jumping while blame loads or lines are uncommitted). */
class Spacer extends GutterMarker {
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-blame";
    el.innerHTML = `<span class="cm-blame-date">${fmtDate(Date.UTC(2000, 11, 28) / 1000)}</span><span class="cm-blame-author">MMMMMMMMMMMM</span>`;
    el.style.visibility = "hidden";
    return el;
  }
}

function markers(view: EditorView) {
  const lines = view.state.field(blameField, false);
  if (!lines) return RangeSet.empty;
  const times = lines.filter((c): c is Commit => !!c).map((c) => c.time);
  const min = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - min);
  const doc = view.state.doc;
  const out = [];
  const n = Math.min(lines.length, doc.lines);
  for (let l = 1; l <= n; l++) {
    const c = lines[l - 1];
    // Age 0 = newest … 1 = oldest; newer lines get a stronger tint, like PyCharm.
    if (c) out.push(new BlameMarker(c, +(1 - (c.time - min) / span).toFixed(2)).range(doc.line(l).from));
  }
  return RangeSet.of(out);
}

export function gitBlame(path: string): Extension {
  // The column only exists while there is blame data (off / untracked file → no empty gap).
  const conf = new Compartment();
  const column = [
    gutter({ class: "cm-blame-gutter", markers, initialSpacer: () => new Spacer() }),
    EditorView.baseTheme({
      ".cm-blame-gutter .cm-gutterElement": { padding: "0 12px 0 8px" },
      ".cm-blame": {
        display: "flex",
        gap: "8px",
        fontFamily: "var(--font)",
        fontSize: "0.78em",
        color: "var(--label-2)",
        opacity: "calc(1 - var(--blame-age, 0) * 0.5)",
        cursor: "default",
        whiteSpace: "nowrap",
      },
      ".cm-blame-date": { fontVariantNumeric: "tabular-nums" },
      ".cm-blame-author": { width: "9em", overflow: "hidden", textOverflow: "ellipsis" },
    }),
  ];
  const loader = ViewPlugin.fromClass(
    class {
      alive = true;
      timer = 0;
      seq = 0;
      constructor(readonly view: EditorView) {
        live.add(this);
        this.reload();
      }
      update(u: ViewUpdate) {
        // Re-blame the buffer shortly after typing stops, so annotations stay exact.
        if (u.docChanged && blameSettings.enabled) {
          clearTimeout(this.timer);
          this.timer = window.setTimeout(() => this.reload(), 1200);
        }
      }
      async reload() {
        const seq = ++this.seq;
        const root = rootHook();
        if (!blameSettings.enabled || !root) {
          this.show(null);
          return;
        }
        const contents = this.view.state.doc.toString();
        const r = await invoke<Blame | null>("git_blame", { root, path, contents }).catch(() => null);
        if (!this.alive || seq !== this.seq) return;
        // The buffer changed while git was running → the result no longer lines up; the debounced
        // re-blame will follow.
        if (this.view.state.doc.toString() !== contents) return;
        const lines = r ? r.lines.map((i) => (i >= 0 ? r.commits[i] : null)) : null;
        this.show(lines);
      }
      shown = false;
      show(lines: Lines | null) {
        const effects: StateEffect<unknown>[] = [setBlame.of(lines)];
        if (!!lines !== this.shown) {
          this.shown = !!lines;
          effects.push(conf.reconfigure(lines ? column : []));
        }
        if (lines || this.view.state.field(blameField, false)) this.view.dispatch({ effects });
      }
      destroy() {
        this.alive = false;
        clearTimeout(this.timer);
        live.delete(this);
      }
    },
  );

  return [blameField, loader, conf.of([])];
}
