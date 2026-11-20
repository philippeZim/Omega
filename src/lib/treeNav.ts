/** Keyboard handling of the file tree (#39), following the ARIA tree pattern. */

export type TreeMove = "next" | "prev" | "first" | "last" | "parent";
export type TreeAction = TreeMove | "expand" | "collapse" | "rename" | "delete";

/** What a key does on a tree row. Enter needs nothing here: rows are buttons, so it clicks them. */
export function treeKeyAction(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">, row: { isDir: boolean; open: boolean }): TreeAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
  switch (e.key) {
    case "ArrowDown": return "next";
    case "ArrowUp": return "prev";
    case "Home": return "first";
    case "End": return "last";
    case "ArrowRight": return row.isDir ? (row.open ? "next" : "expand") : null;
    case "ArrowLeft": return row.isDir && row.open ? "collapse" : "parent";
    case "F2": return "rename";
    case "Delete": return "delete";
  }
  return null;
}

/** Moves the focus from the row `from` to another visible row of its tree (rows carry aria-level). */
export function focusTreeRow(from: HTMLElement, move: TreeMove) {
  const tree = from.closest('[role="tree"]');
  if (!tree) return;
  const rows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const i = rows.indexOf(from);
  const level = (r: HTMLElement) => Number(r.getAttribute("aria-level")) || 0;
  let to: HTMLElement | undefined;
  if (move === "next") to = rows[i + 1];
  else if (move === "prev") to = rows[i - 1];
  else if (move === "first") to = rows[0];
  else if (move === "last") to = rows[rows.length - 1];
  else to = rows.slice(0, Math.max(0, i)).reverse().find((r) => level(r) < level(from));
  if (!to) return;
  to.focus();
  to.scrollIntoView?.({ block: "nearest" });
}
