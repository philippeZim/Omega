/**
 * Obsidian-style callouts: a blockquote whose first line starts with `[!type]`.
 *
 *   > [!tip] Optional title
 *   > Body text …
 *
 * `[!type]-` starts collapsed, `[!type]+` is foldable but open. Unknown types render like `note`.
 */
import { WidgetType, type EditorView } from "@codemirror/view";

/** Canonical type → aliases (same set as Obsidian). */
const TYPES: Record<string, string[]> = {
  note: [],
  abstract: ["summary", "tldr"],
  info: [],
  todo: [],
  tip: ["hint", "important"],
  success: ["check", "done"],
  question: ["help", "faq"],
  warning: ["caution", "attention"],
  failure: ["fail", "missing"],
  danger: ["error"],
  bug: [],
  example: [],
  quote: ["cite"],
};

const ALIAS = new Map<string, string>();
for (const [k, al] of Object.entries(TYPES)) for (const a of [k, ...al]) ALIAS.set(a, k);

export const canonicalType = (t: string) => ALIAS.get(t.toLowerCase()) ?? "note";

// Simple 24×24 stroke icons.
const ICONS: Record<string, string> = {
  note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  abstract: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M8 11h8M8 16h5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  todo: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  tip: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.2.3 1.6 1.5 2.7 2.5 2.7Z"/>',
  success: '<path d="M20 6 9 17l-5-5"/>',
  question: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  warning: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>',
  failure: '<path d="M18 6 6 18M6 6l12 12"/>',
  danger: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="m19 7-3 2M5 7l3 2M19 19l-3-2M5 19l3-2M20 13h-4M4 13h4M10 4l1 2M14 4l-1 2"/>',
  example: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  quote: '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.76-2.02-2-2H4c-1.25 0-2 .75-2 1.97V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .01-1 1.03V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.76-2.02-2-2h-4c-1.25 0-2 .75-2 1.97V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>',
};

const svg = (body: string, cls: string) =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export interface CalloutHead {
  /** canonical type (for colour + icon) */
  type: string;
  /** the type exactly as written */
  raw: string;
  fold: "" | "+" | "-";
  /** offsets relative to the line start */
  markerFrom: number;
  markerTo: number;
  /** offset of the fold sign (+/-) or of where it would go */
  foldAt: number;
  title: string;
}

const HEAD_RE = /^(\s*>[ \t]?)\[!([\w-]+)\]([+-]?)([ \t]*)(.*)$/;

export function parseCalloutHead(lineText: string): CalloutHead | null {
  const m = HEAD_RE.exec(lineText);
  if (!m) return null;
  const markerFrom = m[1].length;
  const foldAt = markerFrom + m[2].length + 3;
  return {
    type: canonicalType(m[2]),
    raw: m[2],
    fold: m[3] as CalloutHead["fold"],
    markerFrom,
    markerTo: foldAt + m[3].length + m[4].length,
    foldAt,
    title: m[5].trim(),
  };
}

const defaultTitle = (raw: string) => raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();

/** Replaces `[!type]± ` with the icon (plus the default title when none is written). */
export class CalloutHeadWidget extends WidgetType {
  constructor(readonly type: string, readonly raw: string, readonly hasTitle: boolean) {
    super();
  }
  eq(o: CalloutHeadWidget) {
    return o.type === this.type && o.raw === this.raw && o.hasTitle === this.hasTitle;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-callout-head";
    el.innerHTML = svg(ICONS[this.type] ?? ICONS.note, "md-callout-icon");
    if (!this.hasTitle) {
      const t = document.createElement("span");
      t.className = "md-callout-title";
      t.textContent = defaultTitle(this.raw);
      el.append(t);
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** Chevron at the end of a foldable callout's title; clicking flips `-` ↔ `+` in the source. */
export class CalloutFoldWidget extends WidgetType {
  constructor(readonly collapsed: boolean, readonly foldPos: number) {
    super();
  }
  eq(o: CalloutFoldWidget) {
    return o.collapsed === this.collapsed && o.foldPos === this.foldPos;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "md-callout-fold" + (this.collapsed ? " collapsed" : "");
    el.innerHTML = svg('<path d="m6 9 6 6 6-6"/>', "");
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ changes: { from: this.foldPos, to: this.foldPos + 1, insert: this.collapsed ? "+" : "-" } });
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
