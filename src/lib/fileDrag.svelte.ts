import { fsApi, joinPath, dirname, basename } from "./api";
import { pathMoved } from "./state.svelte";
import { ui } from "./ui.svelte";

/** Drag state of the explorer: `from` is the dragged path, `target` the folder it would land in. */
export const fileDrag = $state<{ from: string | null; target: string | null; x: number; y: number }>({
  from: null,
  target: null,
  x: 0,
  y: 0,
});

/** Folder a drop at (x, y) would move `from` into, or null when that isn't a valid destination. */
function hitTest(x: number, y: number, from: string): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tree-path]");
  if (!el) return null;
  const p = el.dataset.treePath!;
  const dir = el.dataset.treeDir === "1" ? p : dirname(p);
  if (dir === from || dir.startsWith(from + "/") || dir === dirname(from)) return null;
  return dir;
}

async function move(from: string, dir: string) {
  const to = joinPath(dir, basename(from));
  try {
    await fsApi.rename(from, to);
    pathMoved(from, to);
  } catch (e) {
    ui.toast(String(e), "error");
  }
}

/** pointerdown on an explorer row: becomes a drag once the pointer moved a few pixels. */
export function startFileDrag(e: PointerEvent, path: string) {
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  const onMove = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      started = true;
      fileDrag.from = path;
      document.body.classList.add("file-dragging");
    }
    fileDrag.x = ev.clientX;
    fileDrag.y = ev.clientY;
    fileDrag.target = hitTest(ev.clientX, ev.clientY, path);
  };
  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    if (!started) return;
    const target = fileDrag.target;
    fileDrag.from = null;
    fileDrag.target = null;
    document.body.classList.remove("file-dragging");
    // The pointerup must not also count as a click (which would open the file / toggle the folder).
    const swallow = (ce: MouseEvent) => {
      ce.stopPropagation();
      ce.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (drop && target) move(path, target);
  };
  const up = () => finish(true);
  const key = (ke: KeyboardEvent) => {
    if (ke.key !== "Escape") return;
    ke.preventDefault();
    ke.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}
