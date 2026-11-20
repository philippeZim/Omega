// Markdown heading anchors ("[x](#sec-two)", "other.md#intro"), GitHub style (#42).

/** GitHub-style slug: lower case, punctuation dropped, spaces to "-". Letters of any script stay. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * 0-based line of the heading whose anchor is `fragment` (without "#"), or -1. Knows ATX
 * ("## Title") and setext headings, skips fenced code, and numbers duplicates like GitHub
 * ("title", "title-1", …).
 */
export function findHeadingLine(text: string, fragment: string): number {
  let want = fragment;
  try {
    want = decodeURIComponent(fragment);
  } catch {}
  want = want.toLowerCase();
  const lines = text.split("\n");
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    let title: string | null = null;
    const atx = /^\s{0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line);
    if (atx) title = atx[1] ?? "";
    else if (i + 1 < lines.length && line.trim() && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1]) && !/^\s{0,3}([-*+]|\d+[.)])\s/.test(line))
      title = line;
    if (title === null) continue;
    // Inline markup does not count: "**Bold** `code` [link](x)" → "Bold code link".
    const plain = title.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "");
    const base = headingSlug(plain);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if ((n ? `${base}-${n}` : base) === want) return i;
  }
  return -1;
}
