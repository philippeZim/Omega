/**
 * Obsidian-style Live Preview for CodeMirror 6.
 *
 * Reveal rules (matching Obsidian):
 *  - inline elements (bold, italic, ==hl==, ~~strike~~, `code`, links, $math$, images) show their raw
 *    syntax only when the selection touches that element;
 *  - headings, blockquotes and horizontal rules reveal their markers for the whole line;
 *  - bullets / checkboxes reveal when the cursor touches the marker;
 *  - fenced code hides its fences unless the selection is inside the block;
 *  - tables and $$ math are block widgets that turn into source when the selection enters them;
 *  - callouts (`> [!tip] Title`) show their `[!type]` marker when the cursor is on the title line;
 *    `[!type]-` callouts stay collapsed until the selection enters them.
 * While the mouse button is held, the reveal state is frozen so text doesn't jump mid-drag.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { convertFileSrc } from "@tauri-apps/api/core";
import { CalloutFoldWidget, CalloutHeadWidget, parseCalloutHead } from "./callout";
import { TableWidget } from "./table";
import { BulletWidget, CheckboxWidget, CodeHeaderWidget, HrWidget, ImageWidget, MathWidget, renderMath } from "./widgets";
import "./markdown.css";

// ------------------------------------------------------------ link handling (wired up by the app)

let linkHandler: (href: string, fromPath: string | null) => void = () => {};
export function setLinkHandler(fn: typeof linkHandler) {
  linkHandler = fn;
}

function dirOf(p: string) {
  return p.replace(/\/[^/]*$/, "") || "/";
}

/** decodeURI that keeps the raw text when it is not a valid escape (a literal "%", e.g. "100%.md"). */
function safeDecode(s: string) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

export function resolvePath(href: string, fromPath: string | null): string | null {
  const drive = /^[A-Za-z]:[\\/]/.test(href);
  if (!drive && /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  let p = safeDecode(href.split("#")[0]).replace(/\\/g, "/");
  if (!p.startsWith("/") && !drive) {
    if (!fromPath) return null;
    p = dirOf(fromPath) + "/" + p;
  }
  // Windows paths keep their drive ("C:/…"), POSIX paths start with "/".
  const prefix = /^[A-Za-z]:\//.test(p) ? p.slice(0, 2) : "";
  const parts: string[] = [];
  for (const seg of p.slice(prefix.length).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return prefix + "/" + parts.join("/");
}

function imageSrc(url: string, fromPath: string | null) {
  if (/^(https?|data):/i.test(url)) return url;
  const abs = resolvePath(url, fromPath);
  return abs ? convertFileSrc(abs) : url;
}

// ------------------------------------------------------------ reveal state

const setDragging = StateEffect.define<boolean>();

/** The selection used for revealing syntax; frozen while dragging. */
const reveal = StateField.define<{ sel: EditorSelection; drag: boolean }>({
  create: (s) => ({ sel: s.selection, drag: false }),
  update(v, tr) {
    let drag = v.drag;
    for (const e of tr.effects) if (e.is(setDragging)) drag = e.value;
    if (drag) return { sel: tr.docChanged ? v.sel.map(tr.changes) : v.sel, drag };
    if (!v.drag && !tr.docChanged && !tr.selection) return v;
    return { sel: tr.state.selection, drag };
  },
});

const touches = (sel: EditorSelection, from: number, to: number) => sel.ranges.some((r) => r.from <= to && r.to >= from);

function onLines(state: EditorState, sel: EditorSelection, from: number, to: number) {
  return touches(sel, state.doc.lineAt(from).from, state.doc.lineAt(to).to);
}

// ------------------------------------------------------------ inline markdown for table cells

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderInlineMarkdown(md: string, el: HTMLElement) {
  const math: string[] = [];
  let s = md.replace(/\$([^\s$](?:[^$]*[^\s$])?)\$/g, (_, tex) => `\u0000${math.push(tex) - 1}\u0000`);
  s = esc(s.replace(/\\\|/g, "|"))
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '<strong>$1$2</strong>')
    .replace(/\*([^*]+)\*|_([^_]+)_/g, "<em>$1$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/==([^=]+)==/g, '<mark class="md-hl">$1</mark>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<span class="md-link">$1</span>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => renderMath(math[Number(i)], false));
  el.innerHTML = s || "&#8203;";
}

// ------------------------------------------------------------ block widgets (StateField: may span lines)

function buildBlocks(state: EditorState): DecorationSet {
  const r = state.field(reveal, false);
  if (!r) return Decoration.none;
  const sel = r.sel;
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name === "Table") {
        if (!touches(sel, n.from, n.to))
          out.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(n.from, n.to), renderInlineMarkdown), block: true }).range(n.from, n.to));
        return false;
      }
      if (n.name === "BlockMath") {
        if (!touches(sel, n.from, n.to)) {
          const src = state.sliceDoc(n.from, n.to).replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "");
          out.push(Decoration.replace({ widget: new MathWidget(src.trim(), true), block: true }).range(n.from, n.to));
        }
        return false;
      }
      if (n.name === "Blockquote") {
        const first = state.doc.lineAt(n.from), last = state.doc.lineAt(n.to);
        const head = parseCalloutHead(first.text);
        if (head?.fold === "-" && last.number > first.number && !touches(sel, n.from, n.to)) {
          out.push(Decoration.replace({}).range(first.to, last.to));
          return false;
        }
        return;
      }
      if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "Paragraph") return false;
    },
  });
  return Decoration.set(out, true);
}

const blocks = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(deco, tr) {
    if (tr.docChanged || tr.state.field(reveal, false) !== tr.startState.field(reveal, false) || syntaxTree(tr.state) !== syntaxTree(tr.startState))
      return buildBlocks(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ------------------------------------------------------------ inline decorations (ViewPlugin: visible ranges only)

const INLINE: Record<string, string> = {
  Emphasis: "md-em",
  StrongEmphasis: "md-strong",
  Strikethrough: "md-strike",
  Highlight: "md-hl",
  InlineCode: "md-code",
};
const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "HighlightMark", "CodeMark"]);

function listDepth(node: SyntaxNode) {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") d++;
  return Math.max(0, d - 1);
}

function buildInline(view: EditorView, path: string | null): DecorationSet {
  const { state } = view;
  const r = state.field(reveal, false);
  if (!r) return Decoration.none;
  const sel = r.sel;
  const out: Range<Decoration>[] = [];
  const lines = new Set<string>();
  const slice = (a: number, b: number) => state.sliceDoc(a, b);
  const hide = (a: number, b: number) => a < b && out.push(Decoration.replace({}).range(a, b));
  const mark = (a: number, b: number, cls: string, attributes?: Record<string, string>) =>
    a < b && out.push(Decoration.mark({ class: cls, attributes }).range(a, b));
  const line = (pos: number, cls: string) => {
    const from = state.doc.lineAt(pos).from;
    const key = from + cls;
    if (!lines.has(key)) {
      lines.add(key);
      out.push(Decoration.line({ class: cls }).range(from));
    }
  };
  const widget = (a: number, b: number, w: any) => out.push(Decoration.replace({ widget: w }).range(a, b));
  const withSpace = (pos: number) => (slice(pos, pos + 1) === " " ? pos + 1 : pos);
  const callouts = new Set<number>();
  /** The `[!type]` marker of the callout being decorated; nodes inside it (e.g. a Link) are skipped. */
  let skip: [number, number] | null = null;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(n) {
        const name = n.name;
        const node = n.node;
        if (skip && n.from >= skip[0] && n.to <= skip[1]) return false;

        if (name === "Blockquote") {
          const first = state.doc.lineAt(n.from);
          const head = parseCalloutHead(first.text);
          if (!head || callouts.has(n.from)) return;
          callouts.add(n.from);
          const last = state.doc.lineAt(n.to);
          const collapsed = head.fold === "-" && last.number > first.number && !touches(sel, n.from, n.to);
          const end = collapsed ? first.number : last.number;
          for (let l = first.number; l <= end; l++) {
            let cls = `md-callout md-callout-${head.type}`;
            if (l === first.number) cls += " md-callout-first";
            if (l === end) cls += " md-callout-last";
            line(state.doc.line(l).from, cls);
          }
          const mFrom = first.from + head.markerFrom, mTo = first.from + head.markerTo;
          skip = [mFrom, mTo];
          if (onLines(state, sel, first.from, first.from)) mark(mFrom, mTo, "md-formatting");
          else {
            widget(mFrom, mTo, new CalloutHeadWidget(head.type, head.raw, head.title !== ""));
            mark(mTo, first.to, "md-callout-title");
            if (head.fold)
              out.push(Decoration.widget({ widget: new CalloutFoldWidget(collapsed, first.from + head.foldAt), side: 1 }).range(first.to));
          }
          return;
        }

        const h = /^ATXHeading(\d)$/.exec(name) || /^SetextHeading(\d)$/.exec(name);
        if (h) {
          line(n.from, `md-h md-h${h[1]}`);
          const shown = onLines(state, sel, n.from, n.to);
          node.getChildren("HeaderMark").forEach((m, i) => {
            if (shown) mark(m.from, m.to, "md-formatting");
            else if (name.startsWith("Setext")) hide(m.from, m.to);
            else if (i === 0) hide(m.from, withSpace(m.to));
            else hide(slice(m.from - 1, m.from) === " " ? m.from - 1 : m.from, m.to);
          });
          return;
        }

        if (name === "QuoteMark") {
          line(n.from, "md-quote");
          if (onLines(state, sel, n.from, n.from)) mark(n.from, n.to, "md-formatting");
          else hide(n.from, withSpace(n.to));
          return;
        }

        if (name in INLINE) {
          mark(n.from, n.to, INLINE[name]);
          const shown = touches(sel, n.from, n.to);
          for (let c = node.firstChild; c; c = c.nextSibling)
            if (INLINE_MARKS.has(c.name)) shown ? mark(c.from, c.to, "md-formatting") : hide(c.from, c.to);
          return name === "InlineCode" ? false : undefined;
        }

        if (name === "Link") {
          const marks = node.getChildren("LinkMark");
          const urlNode = node.getChild("URL");
          const url = urlNode ? slice(urlNode.from, urlNode.to) : "";
          if (marks.length >= 2) {
            const tFrom = marks[0].to, tTo = marks[1].from;
            if (touches(sel, n.from, n.to)) {
              mark(tFrom, tTo, "md-link");
              mark(n.from, tFrom, "md-formatting");
              mark(tTo, n.to, "md-formatting");
            } else {
              hide(n.from, tFrom);
              mark(tFrom, tTo, "md-link", url ? { "data-href": url, title: url } : undefined);
              hide(tTo, n.to);
            }
          }
          return;
        }

        if (name === "Image") {
          if (!touches(sel, n.from, n.to)) {
            const urlNode = node.getChild("URL");
            const marks = node.getChildren("LinkMark");
            const alt = marks.length >= 2 ? slice(marks[0].to, marks[1].from) : "";
            if (urlNode) widget(n.from, n.to, new ImageWidget(imageSrc(slice(urlNode.from, urlNode.to), path), alt));
          } else mark(n.from, n.to, "md-formatting");
          return false;
        }

        if (name === "Autolink") {
          const u = node.getChild("URL");
          if (u) {
            if (touches(sel, n.from, n.to)) mark(u.from, u.to, "md-link");
            else {
              hide(n.from, u.from);
              mark(u.from, u.to, "md-link", { "data-href": slice(u.from, u.to) });
              hide(u.to, n.to);
            }
          }
          return false;
        }

        if (name === "URL" && !["Link", "Image", "Autolink", "LinkReference"].includes(node.parent?.name ?? "")) {
          const u = slice(n.from, n.to);
          mark(n.from, n.to, "md-link", { "data-href": /^www\./.test(u) ? "https://" + u : u });
          return;
        }

        if (name === "ListMark") {
          const item = node.parent;
          const list = item?.parent;
          if (!item) return;
          if (list?.name === "OrderedList") return void mark(n.from, n.to, "md-list-num");
          if (list?.name !== "BulletList") return;
          const task = item.getChild("Task");
          const tm = task?.getChild("TaskMarker");
          if (tm) {
            if (!touches(sel, n.from, tm.to)) hide(n.from, withSpace(n.to));
          } else if (!touches(sel, n.from, n.to)) widget(n.from, n.to, new BulletWidget(listDepth(node)));
          return;
        }

        if (name === "TaskMarker") {
          const task = node.parent!;
          const lm = task.parent?.getChild("ListMark");
          const checked = /x/i.test(slice(n.from, n.to));
          if (!touches(sel, lm ? lm.from : n.from, n.to)) widget(n.from, n.to, new CheckboxWidget(checked));
          if (checked) mark(n.to, task.to, "md-task-done");
          return;
        }

        if (name === "HorizontalRule") {
          if (!onLines(state, sel, n.from, n.to)) widget(n.from, n.to, new HrWidget());
          else mark(n.from, n.to, "md-formatting");
          return false;
        }

        if (name === "FencedCode" || name === "CodeBlock") {
          const first = state.doc.lineAt(n.from), last = state.doc.lineAt(n.to);
          for (let l = first.number; l <= last.number; l++) {
            let cls = "md-codeblock";
            if (l === first.number) cls += " md-codeblock-first";
            if (l === last.number) cls += " md-codeblock-last";
            line(state.doc.line(l).from, cls);
          }
          if (name === "CodeBlock") return false;
          const marks = node.getChildren("CodeMark");
          const info = node.getChild("CodeInfo");
          const text = node.getChild("CodeText");
          if (!touches(sel, n.from, n.to)) {
            widget(first.from, first.to, new CodeHeaderWidget(info ? slice(info.from, info.to) : "", text ? slice(text.from, text.to) : ""));
            if (marks.length > 1 && last.number !== first.number) hide(last.from, last.to);
          } else {
            marks.forEach((m) => mark(m.from, m.to, "md-formatting"));
            if (info) mark(info.from, info.to, "md-formatting");
          }
          return false;
        }

        if (name === "InlineMath") {
          if (!touches(sel, n.from, n.to)) widget(n.from, n.to, new MathWidget(slice(n.from + 1, n.to - 1), false));
          else mark(n.from, n.to, "md-math-src");
          return false;
        }

        if (name === "BlockMath" || name === "Table") {
          // Rendered by the block field unless revealed; when revealed show it as source.
          if (touches(sel, n.from, n.to)) {
            for (let l = state.doc.lineAt(n.from).number; l <= state.doc.lineAt(n.to).number; l++)
              line(state.doc.line(l).from, name === "Table" ? "md-table-src" : "md-math-src-line");
          }
          return false;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

function inlinePlugin(path: string | null) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildInline(view, path);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.state.field(reveal, false) !== u.startState.field(reveal, false) ||
          syntaxTree(u.state) !== syntaxTree(u.startState)
        )
          this.decorations = buildInline(u.view, path);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Tracks mouse drags so the reveal state can stay frozen while selecting. */
const dragTracker = ViewPlugin.fromClass(
  class {
    up = () => {
      if (this.view.state.field(reveal, false)?.drag) this.view.dispatch({ effects: setDragging.of(false) });
    };
    constructor(readonly view: EditorView) {
      window.addEventListener("mouseup", this.up);
    }
    destroy() {
      window.removeEventListener("mouseup", this.up);
    }
  },
);

// ------------------------------------------------------------ formatting commands

export function toggleWrap(marker: string) {
  return (view: EditorView) => {
    const { state } = view;
    const len = marker.length;
    view.dispatch(
      state.changeByRange((r) => {
        // Length of the run of marker characters right before / after the selection: with "*" a run of
        // two is bold only (`**x**`), so italic must add its own marker instead of eating half of it.
        const run = (pos: number, dir: -1 | 1) => {
          let n = 0;
          while (state.sliceDoc(pos + (dir < 0 ? -n - 1 : n), pos + (dir < 0 ? -n : n + 1)) === marker[0]) n++;
          return n;
        };
        const n = marker.split("").every((c) => c === marker[0]) ? Math.min(run(r.from, -1), run(r.to, 1)) : 0;
        const wrapped = len === 1 && (marker === "*" || marker === "_") ? n === 1 || n >= 3 : n >= len;
        if (wrapped)
          return {
            changes: [{ from: r.from - len, to: r.from }, { from: r.to, to: r.to + len }],
            range: EditorSelection.range(r.from - len, r.to - len),
          };
        return {
          changes: [{ from: r.from, insert: marker }, { from: r.to, insert: marker }],
          range: EditorSelection.range(r.from + len, r.to + len),
        };
      }),
    );
    return true;
  };
}

export function insertLink(view: EditorView) {
  view.dispatch(
    view.state.changeByRange((r) => {
      const text = view.state.sliceDoc(r.from, r.to);
      const insert = `[${text}]()`;
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length - 1) };
    }),
  );
  return true;
}

// ------------------------------------------------------------ public extension

export function livePreview(path: string | null): Extension {
  return [
    reveal,
    blocks,
    inlinePlugin(path),
    dragTracker,
    EditorView.domEventHandlers({
      mousedown(e, view) {
        const target = e.target as HTMLElement;
        const link = target.closest<HTMLElement>("[data-href]");
        if (link && e.button === 0 && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          linkHandler(link.dataset.href!, path);
          return true;
        }
        if (e.button === 0) view.dispatch({ effects: setDragging.of(true) });
        return false;
      },
    }),
  ];
}
