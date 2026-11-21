/** Breakpoint gutter + execution-line highlight for code mode. */
import { RangeSet, StateEffect, StateField, type Extension, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, gutterLineClass, hoverTooltip, type DecorationSet } from "@codemirror/view";
import { viewActions } from "../editorActions";
import { ySyncAnnotation } from "y-codemirror.next";
import { dbg, dbgHooks, setBreakpointLines, SHARED_BP } from "./store.svelte";
import { blockedByCapability } from "../collab/guard";
import { t } from "../i18n/index.svelte";

/** While stopped: hovering an identifier (incl. a.b.c chains) shows its current value. */
const valueHover = hoverTooltip(async (view, pos) => {
  if (dbg.status !== "stopped") return null;
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  let a = pos - line.from, b = a;
  while (a > 0 && /[\w.$]/.test(text[a - 1])) a--;
  while (b < text.length && /[\w$]/.test(text[b])) b++;
  const expr = text.slice(a, b).replace(/^\.+|\.+$/g, "");
  if (!expr || /^\d/.test(expr)) return null;
  const value = await dbgHooks.hover(expr);
  if (value === null) return null;
  return {
    pos: line.from + a,
    end: line.from + b,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-debug-value";
      const n = document.createElement("span");
      n.textContent = expr + " = ";
      const v = document.createElement("span");
      v.textContent = value;
      dom.append(n, v);
      return { dom };
    },
  };
}, { hoverTime: 250 });

class BpMarker extends GutterMarker {
  constructor(readonly condition: string | undefined, readonly verified: boolean | undefined) {
    super();
  }
  eq(o: BpMarker) {
    return o.condition === this.condition && o.verified === this.verified;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-bp" + (this.condition ? " cond" : "") + (this.verified === false ? " unverified" : "");
    if (this.condition) el.title = t("code.bp.condition", { cond: this.condition });
    return el;
  }
}

/** Faint preview of a breakpoint on the hovered line (shows where a click will put one). */
class GhostMarker extends GutterMarker {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-bp ghost";
    return el;
  }
}
const ghost = new GhostMarker();

/** Highlights the hovered line's number. */
const hoverLineClass = new (class extends GutterMarker {
  elementClass = "cm-bp-hoverline";
})();

class ExecMarker extends GutterMarker {
  /** True when the execution line sits on a breakpoint: one combined icon instead of two overlapping. */
  constructor(readonly onBreakpoint: boolean) {
    super();
  }
  eq(o: ExecMarker) {
    return o.onBreakpoint === this.onBreakpoint;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = this.onBreakpoint ? "cm-exec-bp" : "cm-exec-arrow";
    return el;
  }
}

/** Re-read breakpoints/exec line from the store (dispatched by the controller). */
export const debugRefresh = StateEffect.define<null>();
const toggleBp = StateEffect.define<{ pos: number; condition?: string | null }>();
/** Start of the line under the mouse in the breakpoint hit area, or null. */
const setHover = StateEffect.define<number | null>();
const hoverField = StateField.define<number | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setHover)) v = e.value;
    if (v !== null && tr.docChanged) v = null;
    return v;
  },
  provide: (f) => gutterLineClass.compute([f], (s) => {
    const at = s.field(f);
    return at === null ? RangeSet.empty : RangeSet.of([hoverLineClass.range(at)]);
  }),
});

interface BpValue {
  pos: number;
  condition?: string;
}

function fromStore(state: EditorState, path: string) {
  const list = dbg.breakpoints[path] ?? [];
  const ranges = list
    .filter((b) => b.line <= state.doc.lines)
    .map((b) => new BpMarker(b.condition, b.verified).range(state.doc.line(b.line).from));
  return RangeSet.of(ranges, true);
}

export function debugExtension(path: string): Extension {
  const bpField = StateField.define<RangeSet<BpMarker>>({
    create: (s) => fromStore(s, path),
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(debugRefresh)) {
          // Keep positions from the editor (they follow edits), take verified flags from the store.
          const list = dbg.breakpoints[path] ?? [];
          const ranges: { from: number; value: BpMarker }[] = [];
          set.between(0, tr.state.doc.length, (from, _to, v) => {
            const line = tr.state.doc.lineAt(from).number;
            const b = list.find((x) => x.line === line);
            if (b) ranges.push({ from, value: new BpMarker(b.condition, b.verified) });
          });
          // Breakpoints added from elsewhere (panel/other view) appear too.
          for (const b of list)
            if (b.line <= tr.state.doc.lines && !ranges.some((r) => tr.state.doc.lineAt(r.from).number === b.line))
              ranges.push({ from: tr.state.doc.line(b.line).from, value: new BpMarker(b.condition, b.verified) });
          set = RangeSet.of(ranges.map((r) => r.value.range(r.from)), true);
        }
        if (e.is(toggleBp)) {
          const lineFrom = tr.state.doc.lineAt(e.value.pos).from;
          let has = false;
          set.between(lineFrom, lineFrom, () => {
            has = true;
          });
          if (e.value.condition !== undefined) {
            set = set.update({ filter: (from) => from !== lineFrom });
            if (e.value.condition !== null) set = set.update({ add: [new BpMarker(e.value.condition || undefined, undefined).range(lineFrom)] });
          } else if (has) set = set.update({ filter: (from) => from !== lineFrom });
          else set = set.update({ add: [new BpMarker(undefined, undefined).range(lineFrom)] });
        }
      }
      return set;
    },
  });

  const execField = StateField.define<DecorationSet>({
    create: (s) => execDeco(s, path),
    update(deco, tr) {
      if (tr.effects.some((e) => e.is(debugRefresh))) return execDeco(tr.state, path);
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const sync = (view: EditorView) => {
    const lines: { line: number; condition?: string }[] = [];
    const field = view.state.field(bpField, false);
    if (!field) return; // mode switched away meanwhile
    field.between(0, view.state.doc.length, (from, _to, v) => {
      lines.push({ line: view.state.doc.lineAt(from).number, condition: v.condition });
    });
    lines.sort((a, b) => a.line - b.line);
    setBreakpointLines(path, lines);
  };

  let timer: number | undefined;
  const shared = path.startsWith(SHARED_BP);

  const toggleAt = (view: EditorView, pos: number, condition?: string | null) => {
    if (shared && blockedByCapability("debug")) return;
    view.dispatch({ effects: toggleBp.of({ pos, condition }) });
    sync(view);
  };

  return [
    bpField,
    execField,
    valueHover,
    gutter({
      class: "cm-bp-gutter",
      markers: (v) => {
        let bps: RangeSet<GutterMarker> = v.state.field(bpField, false) ?? RangeSet.empty;
        const hover = v.state.field(hoverField, false);
        if (hover != null && hover <= v.state.doc.length) {
          let has = false;
          bps.between(hover, hover, () => {
            has = true;
          });
          if (!has) bps = RangeSet.join<GutterMarker>([bps, RangeSet.of<GutterMarker>([ghost.range(hover)])]);
        }
        if (dbg.exec?.path !== path || dbg.exec.line > v.state.doc.lines) return bps;
        const at = v.state.doc.line(dbg.exec.line).from;
        let onBp = false;
        bps.between(at, at, () => {
          onBp = true;
        });
        // The exec icon replaces whatever sits on that line (breakpoint → combined icon, ghost → arrow).
        const rest = bps.update({ filter: (from) => from !== at });
        return RangeSet.join<GutterMarker>([rest, RangeSet.of<GutterMarker>([new ExecMarker(onBp).range(at)])]);
      },
      initialSpacer: () => new BpMarker(undefined, undefined),
    }),
    hoverField,
    // Hit area = breakpoint column + git stripe + line number (everything left of the fold
    // gutter). Listeners sit on the scroller because CodeMirror's own handlers only cover
    // the content, not the gutters.
    ViewPlugin.define((view) => {
      const lineAt = (e: MouseEvent): number | null => {
        const target = e.target as Element | null;
        if (!target?.closest(".cm-gutters")) return null;
        const nums = view.dom.querySelector(".cm-lineNumbers");
        if (nums && e.clientX > nums.getBoundingClientRect().right) return null;
        const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
        return block.from <= view.state.doc.length ? block.from : null;
      };
      const hover = (at: number | null) => {
        if (view.state.field(hoverField, false) !== at) view.dispatch({ effects: setHover.of(at) });
      };
      const onMove = (e: MouseEvent) => hover(lineAt(e));
      const onLeave = () => hover(null);
      const onDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        const at = lineAt(e);
        if (at === null) return;
        e.preventDefault();
        toggleAt(view, at);
      };
      const onMenu = (e: MouseEvent) => {
        const at = lineAt(e);
        if (at === null) return;
        e.preventDefault();
        e.stopPropagation();
        const current = (dbg.breakpoints[path] ?? []).find((b) => b.line === view.state.doc.lineAt(at).number)?.condition ?? "";
        conditionHook(current).then((c) => {
          if (c !== null) toggleAt(view, at, c);
        });
      };
      const el = view.scrollDOM;
      el.addEventListener("mousemove", onMove);
      el.addEventListener("mouseleave", onLeave);
      el.addEventListener("mousedown", onDown);
      el.addEventListener("contextmenu", onMenu);
      return {
        destroy() {
          el.removeEventListener("mousemove", onMove);
          el.removeEventListener("mouseleave", onLeave);
          el.removeEventListener("mousedown", onDown);
          el.removeEventListener("contextmenu", onMenu);
        },
      };
    }),
    viewActions.of({ "debug.toggleBreakpoint": (v) => (toggleAt(v, v.state.selection.main.head), true) }),
    EditorView.updateListener.of((u) => {
      // Shared file: whoever typed moves the breakpoints, so a remote edit isn't reported back.
      const own = !shared || u.transactions.some((tr) => tr.docChanged && tr.annotation(ySyncAnnotation) === undefined);
      if (u.docChanged && own) {
        clearTimeout(timer);
        // Shared: at once, so a state update from the host can't put the marker back meanwhile.
        timer = window.setTimeout(() => sync(u.view), shared ? 0 : 400);
      }
    }),
    EditorView.baseTheme({
      ".cm-bp-gutter": { width: "24px", paddingLeft: "6px" },
      ".cm-bp-gutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", position: "relative" },
      // Pointer over the whole hit area (breakpoint column, git stripe, line numbers).
      ".cm-gutters": { cursor: "pointer" },
      ".cm-foldGutter": { cursor: "default" },
      ".cm-lineNumbers .cm-bp-hoverline": { color: "var(--label-2)" },
      ".cm-bp": { width: "11px", height: "11px", borderRadius: "50%", background: "#df7067", boxShadow: "0 0 0 2px rgba(223, 112, 103,0.25)", position: "relative", zIndex: "1" },
      ".cm-bp.ghost": { opacity: "0.35", boxShadow: "none" },
      ".cm-bp.cond": { background: "#d6a35f", boxShadow: "0 0 0 2px rgba(214, 163, 95,0.25)" },
      ".cm-bp.unverified": { background: "transparent", border: "2px solid #df7067", boxShadow: "none" },
      // Current line (not on a breakpoint): a rounded yellow arrow tag.
      ".cm-exec-arrow": { position: "absolute", width: "13px", height: "11px", background: "#d8c27a", clipPath: "polygon(0 0, 55% 0, 100% 50%, 55% 100%, 0 100%)", borderRadius: "2px", zIndex: "2" },
      ".cm-debug-value": { padding: "6px 10px", fontFamily: "var(--mono)", fontSize: "12.5px", maxWidth: "600px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
      ".cm-debug-value span:first-child": { color: "#a996cf" },
      // Stopped on a breakpoint: keep the red dot, ringed in the current-line yellow.
      ".cm-exec-bp": {
        width: "11px",
        height: "11px",
        borderRadius: "50%",
        background: "#df7067",
        boxShadow: "0 0 0 2px #d8c27a, 0 0 6px 2px rgba(216, 194, 122, 0.35)",
        position: "relative",
        zIndex: "2",
      },
      ".cm-exec-line": { backgroundColor: "rgba(216, 194, 122,0.16) !important", boxShadow: "inset 3px 0 0 #d8c27a" },
    }),
  ];
}

function execDeco(state: EditorState, path: string): DecorationSet {
  if (dbg.exec?.path !== path || dbg.exec.line > state.doc.lines) return Decoration.none;
  return Decoration.set([Decoration.line({ class: "cm-exec-line" }).range(state.doc.line(dbg.exec.line).from)]);
}

/** Asks for a breakpoint condition; set by the app (custom dialog). Resolves null on cancel, "" removes the condition. */
let conditionHook: (current: string) => Promise<string | null> = async () => null;
export function setConditionHook(fn: typeof conditionHook) {
  conditionHook = fn;
}
