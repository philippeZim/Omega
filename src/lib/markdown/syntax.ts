/** Obsidian-flavoured syntax additions for @lezer/markdown: ==highlight==, $inline math$, $$block math$$. */
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

export const Highlight: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark", style: t.processingInstruction }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        // Only exactly "==": the parser retries every position, so also reject the middle of a longer "=" run.
        if (next != 61 /* = */ || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61 || cx.char(pos - 1) == 61) return -1;
        const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter, !sBefore);
      },
      after: "Emphasis",
    },
  ],
};

export const InlineMath: MarkdownConfig = {
  defineNodes: [{ name: "InlineMath" }, { name: "InlineMathMark", style: t.processingInstruction }],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        // "$$" is block math only; reject it from both of its dollars, since the parser retries at the second one.
        if (next != 36 /* $ */ || cx.char(pos + 1) == 36 || cx.char(pos - 1) == 36) return -1;
        // Like Obsidian: no whitespace right inside the dollars ("costs $5 and $6" is not math).
        if (/\s/.test(String.fromCharCode(cx.char(pos + 1)))) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c == 92 /* \ */) { i++; continue; }
          if (c == 36) {
            if (i == pos + 1 || /\s/.test(String.fromCharCode(cx.char(i - 1)))) return -1;
            return cx.addElement(
              cx.elt("InlineMath", pos, i + 1, [cx.elt("InlineMathMark", pos, pos + 1), cx.elt("InlineMathMark", i, i + 1)]),
            );
          }
        }
        return -1;
      },
      before: "Emphasis",
    },
  ],
};

export const BlockMath: MarkdownConfig = {
  defineNodes: [{ name: "BlockMath", block: true }, { name: "BlockMathMark", style: t.processingInstruction }],
  parseBlock: [
    {
      name: "BlockMath",
      parse(cx, line) {
        if (!line.text.slice(line.pos).startsWith("$$")) return false;
        const start = cx.lineStart + line.pos;
        const rest = line.text.slice(line.pos + 2).trimEnd();
        // One-liner: $$ x^2 $$
        if (rest.length >= 2 && rest.endsWith("$$")) {
          const end = cx.lineStart + line.text.trimEnd().length;
          cx.nextLine();
          cx.addElement(cx.elt("BlockMath", start, end, [cx.elt("BlockMathMark", start, start + 2), cx.elt("BlockMathMark", end - 2, end)]));
          return true;
        }
        const marks = [cx.elt("BlockMathMark", start, start + 2)];
        let end = -1;
        while (cx.nextLine()) {
          const trimmed = line.text.trimEnd();
          if (trimmed.endsWith("$$")) {
            end = cx.lineStart + trimmed.length;
            marks.push(cx.elt("BlockMathMark", end - 2, end));
            cx.nextLine();
            break;
          }
        }
        if (end < 0) end = cx.prevLineEnd();
        cx.addElement(cx.elt("BlockMath", start, end, marks));
        return true;
      },
      before: "FencedCode",
    },
  ],
};

/** `[[text]](url)` or `[[text]][label]`: a Link whose text `[text]` ends at `close` (its `]`). */
function bracketedLink(cx: InlineContext, start: number, close: number) {
  const open = close + 1;
  const closer = cx.char(open) == 40 ? 41 /* ) */ : 93; /* ] */
  let end = -1;
  for (let j = open + 1; j < cx.end; j++) {
    const c = cx.char(j);
    if (c == 10 || (closer == 93 && c == 91)) return -1;
    if (c == closer) { end = j; break; }
  }
  if (end < 0) return -1;
  const marks = [cx.elt("LinkMark", start, start + 1), cx.elt("LinkMark", close, close + 1)];
  if (closer == 93) {
    marks.push(cx.elt("LinkLabel", open, end + 1));
  } else {
    let u = open + 1;
    while (u < end && cx.char(u) == 32) u++;
    let ue = u;
    if (cx.char(u) == 60 /* < */) {
      while (ue < end && cx.char(ue) != 62 /* > */) ue++;
      ue = Math.min(ue + 1, end);
    } else while (ue < end && cx.char(ue) != 32) ue++;
    marks.push(cx.elt("LinkMark", open, open + 1));
    if (ue > u) marks.push(cx.elt("URL", u, ue));
    marks.push(cx.elt("LinkMark", end, end + 1));
  }
  return cx.addElement(cx.elt("Link", start, end + 1, marks));
}

/** Obsidian `[[target]]`, `[[target#heading]]` and `[[target|shown text]]` on one line. */
export const WikiLink: MarkdownConfig = {
  defineNodes: [{ name: "WikiLink", style: t.link }, { name: "WikiLinkMark", style: t.processingInstruction }],
  parseInline: [
    {
      name: "WikiLink",
      parse(cx, next, pos) {
        if (next != 91 /* [ */ || cx.char(pos + 1) != 91) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const c = cx.char(i);
          if (c == 10 /* \n */ || c == 91) return -1;
          if (c == 93 /* ] */) {
            if (cx.char(i + 1) != 93 || i == pos + 2) return -1;
            // `[[PDF]](file.pdf)` / `[[1]][ref]` are ordinary links whose text is in brackets. @lezer/markdown
            // would only make `[PDF]` a link (a link can't contain one), so build the outer Link here.
            const after = cx.char(i + 2);
            if (after == 40 /* ( */ || after == 91 /* [ */) return bracketedLink(cx, pos, i + 1);
            return cx.addElement(
              cx.elt("WikiLink", pos, i + 2, [cx.elt("WikiLinkMark", pos, pos + 2), cx.elt("WikiLinkMark", i, i + 2)]),
            );
          }
        }
        return -1;
      },
      before: "Link",
    },
  ],
};
