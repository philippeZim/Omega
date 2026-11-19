/** Breakpoint gutter + execution-line highlight for code mode. */
import { RangeSet, StateEffect, StateField, type Extension, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, hoverTooltip, type DecorationSet } from "@codemirror/view";
import { viewActions } from "../editorActions";
import { dbg, dbgHooks, setBreakpointLines } from "./store.svelte";
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

  const toggleAt = (view: EditorView, pos: number, condition?: string | null) => {
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
        const bps = v.state.field(bpField, false) ?? RangeSet.empty;
        if (dbg.exec?.path !== path || dbg.exec.line > v.state.doc.lines) return bps;
        const at = v.state.doc.line(dbg.exec.line).from;
        let onBp = false;
        bps.between(at, at, () => {
          onBp = true;
        });
        const rest = onBp ? bps.update({ filter: (from) => from !== at }) : bps;
        return RangeSet.join<GutterMarker>([rest, RangeSet.of<GutterMarker>([new ExecMarker(onBp).range(at)])]);
      },
      initialSpacer: () => new BpMarker(undefined, undefined),
      domEventHandlers: {
        mousedown(view, line, e) {
          if ((e as MouseEvent).button !== 0) return false;
          toggleAt(view, line.from);
          return true;
        },
        contextmenu(view, line, e) {
          e.preventDefault();
          const current = (dbg.breakpoints[path] ?? []).find((b) => b.line === view.state.doc.lineAt(line.from).number)?.condition ?? "";
          conditionHook(current).then((c) => {
            if (c !== null) toggleAt(view, line.from, c);
          });
          return true;
        },
      },
    }),
    viewActions.of({ "debug.toggleBreakpoint": (v) => (toggleAt(v, v.state.selection.main.head), true) }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        clearTimeout(timer);
        timer = window.setTimeout(() => sync(u.view), 400);
      }
    }),
    EditorView.baseTheme({
      ".cm-bp-gutter": { width: "18px", paddingLeft: "4px", cursor: "default" },
      ".cm-bp-gutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", position: "relative" },
      ".cm-bp-gutter .cm-gutterElement:hover::after": { content: '""', width: "10px", height: "10px", borderRadius: "50%", background: "rgba(223, 112, 103,0.35)", position: "absolute" },
      ".cm-bp": { width: "11px", height: "11px", borderRadius: "50%", background: "#df7067", boxShadow: "0 0 0 2px rgba(223, 112, 103,0.25)", position: "relative", zIndex: "1" },
      ".cm-bp.cond": { background: "#d6a35f", boxShadow: "0 0 0 2px rgba(214, 163, 95,0.25)" },
      ".cm-bp.unverified": { background: "transparent", border: "2px solid #df7067", boxShadow: "none" },
      ".cm-exec-arrow": { position: "absolute", width: "0", height: "0", borderTop: "6px solid transparent", borderBottom: "6px solid transparent", borderLeft: "9px solid #d8c27a", zIndex: "2" },
      ".cm-debug-value": { padding: "6px 10px", fontFamily: "var(--mono)", fontSize: "12.5px", maxWidth: "600px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
      ".cm-debug-value span:first-child": { color: "#a996cf" },
      ".cm-exec-bp": {
        width: "13px",
        height: "13px",
        borderRadius: "50%",
        background: "#df7067",
        boxShadow: "0 0 0 2px rgba(216, 194, 122, 0.45)",
        position: "relative",
        zIndex: "2",
      },
      ".cm-exec-bp::after": {
        content: '""',
        position: "absolute",
        left: "4.5px",
        top: "3px",
        borderTop: "3.5px solid transparent",
        borderBottom: "3.5px solid transparent",
        borderLeft: "5px solid #d8c27a",
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
