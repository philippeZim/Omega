/** Obsidian-1.5-style table editor: the table is rendered, cells are edited in place, the doc stays plain Markdown. */
import { WidgetType, type EditorView } from "@codemirror/view";
import { Annotation } from "@codemirror/state";
import { t as tr } from "../i18n/index.svelte";
import { knownHeight, trackHeight, untrackHeight } from "./widgetHeights";

type Align = "left" | "center" | "right" | null;
interface Table {
  header: string[];
  align: Align[];
  rows: string[][];
}

export const tableEdit = Annotation.define<boolean>();

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (s[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

export function parseTable(text: string): Table {
  const lines = text.split("\n").filter((l) => l.trim());
  const header = splitRow(lines[0] ?? "");
  const align = splitRow(lines[1] ?? "").map((c): Align => {
    const l = c.startsWith(":"), r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
  const rows = lines.slice(2).map(splitRow);
  const n = Math.max(header.length, ...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(Math.max(0, n - r.length)).fill("")];
  return { header: pad(header), align: [...align, ...Array(Math.max(0, n - align.length)).fill(null)].slice(0, n), rows: rows.map(pad) };
}

const width = (s: string) => [...s].length;

export function serializeTable(t: Table): string {
  const n = t.header.length;
  const w = Array.from({ length: n }, (_, i) => Math.max(3, width(t.header[i]), ...t.rows.map((r) => width(r[i] ?? ""))));
  const cell = (s: string, i: number) => {
    const pad = w[i] - width(s);
    if (t.align[i] === "right") return " ".repeat(pad) + s;
    if (t.align[i] === "center") return " ".repeat(pad >> 1) + s + " ".repeat(pad - (pad >> 1));
    return s + " ".repeat(pad);
  };
  const row = (r: string[]) => "| " + r.map(cell).join(" | ") + " |";
  const delim = "| " + w.map((x, i) => {
    const a = t.align[i];
    const d = "-".repeat(a === "center" ? x - 2 : a ? x - 1 : x);
    return a === "center" ? `:${d}:` : a === "right" ? `${d}:` : a === "left" ? `:${d}` : d;
  }).join(" | ") + " |";
  return [row(t.header), delim, ...t.rows.map(row)].join("\n");
}

const escapeCell = (s: string) => s.replace(/\n/g, " ").replace(/(?<!\\)\|/g, "\\|");

interface TableDom extends HTMLElement {
  _text?: string;
}

export class TableWidget extends WidgetType {
  constructor(readonly text: string, readonly render: (md: string, el: HTMLElement) => void) {
    super();
  }
  eq(other: TableWidget) {
    return other.text === this.text;
  }

  /** The height it had when last rendered, else a guess from its rows (#297). */
  get estimatedHeight() {
    return knownHeight("table:" + this.text) ?? 62 + 37 * (this.text.trim().split("\n").length - 1);
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div") as TableDom;
    wrap.className = "md-table-wrap";
    this.fill(wrap, view);
    trackHeight(wrap, "table:" + this.text);
    return wrap;
  }

  destroy(dom: HTMLElement) {
    untrackHeight(dom);
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    const d = dom as TableDom;
    d._text = this.text;
    // While a cell is being edited, keep the DOM (and the caret) — the doc already matches it.
    if (dom.contains(document.activeElement)) return true;
    dom.textContent = "";
    this.fill(d, view);
    return true;
  }

  ignoreEvent() {
    return true;
  }

  private fill(wrap: TableDom, view: EditorView) {
    wrap._text = this.text;
    const t = parseTable(this.text);
    const table = document.createElement("table");
    const mk = (tag: "th" | "td", value: string, r: number, c: number) => {
      const el = document.createElement(tag);
      el.contentEditable = "true";
      el.spellcheck = false;
      el.dataset.r = String(r);
      el.dataset.c = String(c);
      if (t.align[c]) el.style.textAlign = t.align[c]!;
      el.dataset.src = value;
      this.render(value, el);
      el.addEventListener("focus", () => {
        el.textContent = el.dataset.src ?? "";
      });
      el.addEventListener("blur", () => {
        this.render(el.dataset.src ?? "", el);
      });
      el.addEventListener("input", () => {
        el.dataset.src = el.textContent ?? "";
        commit(wrap, view);
      });
      el.addEventListener("keydown", (e) => onKey(e, wrap, view, el));
      return el;
    };
    const thead = table.createTHead().insertRow();
    t.header.forEach((h, c) => thead.appendChild(mk("th", h, 0, c)));
    const tbody = table.createTBody();
    t.rows.forEach((row, r) => {
      const tr = tbody.insertRow();
      row.forEach((v, c) => tr.appendChild(mk("td", v, r + 1, c)));
    });
    wrap.appendChild(table);

    const addRow = document.createElement("button");
    addRow.className = "md-table-add row";
    addRow.textContent = "+";
    addRow.title = tr("commands.md.addRow");
    addRow.onmousedown = (e) => {
      e.preventDefault();
      const cur = parseTable(wrap._text!);
      cur.rows.push(cur.header.map(() => ""));
      replace(wrap, view, serializeTable(cur), false);
    };
    const addCol = document.createElement("button");
    addCol.className = "md-table-add col";
    addCol.textContent = "+";
    addCol.title = tr("commands.md.addCol");
    addCol.onmousedown = (e) => {
      e.preventDefault();
      const cur = parseTable(wrap._text!);
      cur.header.push("");
      cur.align.push(null);
      cur.rows.forEach((r) => r.push(""));
      replace(wrap, view, serializeTable(cur), false);
    };
    wrap.append(addRow, addCol);
  }
}

function collect(wrap: TableDom): Table {
  const t = parseTable(wrap._text!);
  wrap.querySelectorAll<HTMLElement>("th, td").forEach((el) => {
    const r = Number(el.dataset.r), c = Number(el.dataset.c);
    const v = escapeCell(el.dataset.src ?? "");
    if (r === 0) t.header[c] = v;
    else t.rows[r - 1][c] = v;
  });
  return t;
}

function replace(wrap: TableDom, view: EditorView, text: string, keepDom: boolean) {
  const from = view.posAtDOM(wrap);
  const to = from + wrap._text!.length;
  wrap._text = text;
  view.dispatch({ changes: { from, to, insert: text }, annotations: tableEdit.of(keepDom), userEvent: "input.table" });
}

function commit(wrap: TableDom, view: EditorView) {
  replace(wrap, view, serializeTable(collect(wrap)), true);
}

function focusCell(wrap: HTMLElement, r: number, c: number) {
  const el = wrap.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`);
  if (!el) return false;
  el.focus();
  const sel = getSelection()!;
  sel.selectAllChildren(el);
  sel.collapseToEnd();
  return true;
}

function onKey(e: KeyboardEvent, wrap: TableDom, view: EditorView, el: HTMLElement) {
  const r = Number(el.dataset.r), c = Number(el.dataset.c);
  const t = parseTable(wrap._text!);
  const cols = t.header.length, rows = t.rows.length + 1;
  if (e.key === "Tab") {
    e.preventDefault();
    let nr = r, nc = c + (e.shiftKey ? -1 : 1);
    if (nc >= cols) { nc = 0; nr++; }
    if (nc < 0) { nc = cols - 1; nr--; }
    if (nr >= rows) {
      // Tab in the last cell adds a row, like Obsidian.
      t.rows.push(t.header.map(() => ""));
      replace(wrap, view, serializeTable(t), false);
      requestAnimationFrame(() => focusCell(view.dom.querySelector(".md-table-wrap:focus-within") ?? findWrap(view, wrap), nr, 0));
      return;
    }
    focusCell(wrap, nr, nc);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (!focusCell(wrap, r + 1, c)) leave(view, wrap, 1);
  } else if (e.key === "ArrowUp" && r === 0) {
    e.preventDefault();
    leave(view, wrap, -1);
  } else if (e.key === "ArrowDown" && r === rows - 1) {
    e.preventDefault();
    leave(view, wrap, 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    leave(view, wrap, 1);
  }
}

function findWrap(view: EditorView, old: HTMLElement): HTMLElement {
  return document.body.contains(old) ? old : (view.dom.querySelector(".md-table-wrap") as HTMLElement);
}

/** Moves the editor cursor just before/after the table. */
function leave(view: EditorView, wrap: TableDom, dir: 1 | -1) {
  const from = view.posAtDOM(wrap);
  const to = from + wrap._text!.length;
  const pos = dir < 0 ? Math.max(0, from - 1) : Math.min(view.state.doc.length, to + 1);
  (document.activeElement as HTMLElement | null)?.blur();
  view.focus();
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
}
