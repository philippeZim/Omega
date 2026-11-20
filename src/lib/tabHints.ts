/**
 * Hints that tell tabs with the same file name apart (#38), like VS Code: for every tab whose name
 * clashes with another tab, the shortest tail of its parent folders that no other clashing tab
 * shares ("sub", "a/src"). Tabs without a clash, or without a path, get "".
 */
export function tabHints(tabs: { name: string; path: string | null }[]): string[] {
  const dirs = tabs.map((t) => (t.path ? t.path.split(/[\\/]/).filter(Boolean).slice(0, -1) : null));
  return tabs.map((tab, i) => {
    const mine = dirs[i];
    if (!mine) return "";
    const others = tabs.flatMap((o, j) => (j !== i && o.name === tab.name && dirs[j] ? [dirs[j]!] : []));
    if (!others.length) return "";
    const tail = (d: string[], k: number) => d.slice(Math.max(0, d.length - k)).join("/");
    for (let k = 1; k <= mine.length; k++) {
      const hint = tail(mine, k);
      if (others.every((d) => tail(d, k) !== hint)) return hint;
    }
    return mine.length ? mine.join("/") : "/";
  });
}
