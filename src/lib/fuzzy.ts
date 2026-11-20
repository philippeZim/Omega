/**
 * Fuzzy matching in the spirit of IntelliJ's "Go to File": characters must appear in order;
 * matches at word starts (after / _ - . or camelCase humps) and consecutive runs score higher.
 * Returns null when there is no match, else a score and the matched character positions.
 */
export function fuzzy(query: string, text: string): { score: number; positions: number[] } | null {
  if (!query) return { score: 0, positions: [] };
  // Try several start positions for the first character and keep the best-scoring match.
  const first = query.toLowerCase().replace(/ /g, "")[0];
  const t = text.toLowerCase();
  let best: { score: number; positions: number[] } | null = null;
  for (let i = t.indexOf(first), n = 0; i >= 0 && n < 24; i = t.indexOf(first, i + 1), n++) {
    const m = smart(query, text, i);
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best ?? plain(query, text);
}

/** Fallback: plain in-order subsequence (always finds a match if one exists). */
function plain(query: string, text: string): { score: number; positions: number[] } | null {
  const q = query.toLowerCase(), t = text.toLowerCase();
  const positions: number[] = [];
  let ti = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const j = t.indexOf(ch, ti);
    if (j < 0) return null;
    positions.push(j);
    ti = j + 1;
  }
  let score = positions.length;
  for (let i = 1; i < positions.length; i++) if (positions[i] === positions[i - 1] + 1) score += 3;
  return { score: score - text.length * 0.05, positions };
}

function smart(query: string, text: string, start = 0): { score: number; positions: number[] } | null {
  const q = query.toLowerCase(), t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0, ti = start, prev = -2;
  let firstChar = true;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === " ") continue;
    let found = -1;
    // Continue a consecutive run if possible; otherwise prefer a word start ahead, else the next occurrence.
    if (firstChar) {
      found = t[start] === ch ? start : -1;
      firstChar = false;
    } else if (prev >= 0 && t[prev + 1] === ch) found = prev + 1;
    else for (let j = ti; j < t.length; j++) {
      if (t[j] !== ch) continue;
      if (isWordStart(text, j)) { found = j; break; }
      if (found < 0) found = j;
    }
    if (found < 0) return null;
    score += 1;
    // The run bonus must exceed the word-start bonus, so a contiguous match beats one scattered over word starts.
    if (found === prev + 1) score += 9;
    if (isWordStart(text, found)) score += 8;
    if (found === 0) score += 6;
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  // Shorter candidates and matches in the file name (after the last /) rank higher.
  const slash = text.lastIndexOf("/");
  if (positions.length && positions[0] > slash) score += 10;
  // Extra bonus when the whole query is one run at the start of the file name.
  if (positions.length && positions[0] === slash + 1 && positions[positions.length - 1] - positions[0] === positions.length - 1) score += 10;
  score -= text.length * 0.05;
  return { score, positions };
}

function isWordStart(s: string, i: number) {
  if (i === 0) return true;
  const p = s[i - 1], c = s[i];
  return "/_-. ".includes(p) || (p >= "a" && p <= "z" && c >= "A" && c <= "Z");
}

/** Splits text into [plain, matched] segments for highlighting. */
export function highlight(text: string, positions: number[]): { t: string; m: boolean }[] {
  const set = new Set(positions);
  const out: { t: string; m: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (out.length && out[out.length - 1].m === m) out[out.length - 1].t += text[i];
    else out.push({ t: text[i], m });
  }
  return out;
}
