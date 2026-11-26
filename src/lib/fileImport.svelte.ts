/**
 * Files from outside into the explorer (#299): dropped from a file manager, or pasted from the
 * clipboard (files copied in a file manager, or an image such as a screenshot). The explorer's own
 * "Copy" puts its files on the clipboard the same way, so they paste back here or into a file manager.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { fsApi, dirname, basename } from "./api";
import { fsErrorText } from "./fsError";
import { app } from "./state.svelte";
import { ui } from "./ui.svelte";
import { t } from "./i18n/index.svelte";
import { OS } from "./platform";

/** Folder a file-manager drag currently hovers in the explorer (null: not over the tree). */
export const externalDrop = $state<{ target: string | null }>({ target: null });

/** The folder a drop or paste on the explorer element `el` lands in. */
export function folderOf(el: Element | null): string | null {
  const row = el?.closest<HTMLElement>("[data-tree-path]");
  if (!row) return null;
  const p = row.dataset.treePath!;
  return row.dataset.treeDir === "1" ? p : dirname(p);
}

/** Reloads the explorer; the row that had the keyboard focus gets it back (the reload remounts it). */
function refreshTree() {
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-tree-path]")?.dataset.treePath;
  app.treeVersion++;
  if (focused === undefined) return;
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[role="treeitem"][data-tree-path="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true }));
}

/** Copies `sources` into `dir` and reports it. Returns the new paths ([] on failure). */
export async function importFiles(sources: string[], dir: string): Promise<string[]> {
  if (!sources.length) return [];
  try {
    const made = await invoke<string[]>("copy_into", { sources, dir });
    ui.toast(made.length === 1 ? t("app.import.copiedOne", { name: basename(made[0]) }) : t("app.import.copied", { n: made.length }));
    refreshTree();
    return made;
  } catch (e) {
    ui.toast(fsErrorText(e, String(e) === "fs:into_itself" || String(e) === "fs:not_dir" ? dir : sources[0]), "error");
    return [];
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** File name for a pasted image, e.g. "image-2026-11-26-143005.png". */
export function pastedImageName(d = new Date()): string {
  return `image-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

async function clipboardImagePng(): Promise<Uint8Array | null> {
  let img;
  try {
    img = await readImage();
  } catch {
    return null; // no image on the clipboard
  }
  try {
    const [{ width, height }, rgba] = await Promise.all([img.size(), img.rgba()]);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    img.close?.();
  }
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Pastes the clipboard into `dir`: copied files, else an image as a new PNG. */
export async function pasteInto(dir: string) {
  const files = await invoke<string[]>("clipboard_files").catch(() => [] as string[]);
  if (files.length) return void (await importFiles(files, dir));
  const png = await clipboardImagePng();
  if (!png) return ui.toast(t("app.import.nothing"), "error");
  try {
    const path = await invoke<string>("create_file_base64", { dir, name: pastedImageName(), data: base64(png) });
    ui.toast(t("app.import.copiedOne", { name: basename(path) }));
    refreshTree();
  } catch (e) {
    ui.toast(fsErrorText(e, dir), "error");
  }
}

/** "Copy" in the explorer: the file goes on the clipboard as a file (pastes in file managers too). */
export async function copyToClipboard(paths: string[]) {
  const ok = await invoke<boolean>("clipboard_set_files", { paths }).catch(() => false);
  if (!ok) await navigator.clipboard.writeText(paths.join("\n")).catch(() => {});
  ui.toast(paths.length === 1 ? t("app.import.onClipboard", { name: basename(paths[0]) }) : t("app.import.onClipboardN", { n: paths.length }));
}

/**
 * Turns a drag position from Tauri into CSS pixels. Despite its type it arrives in logical pixels
 * on Linux (GTK) and macOS (AppKit points), in physical ones on Windows (wry's drag_drop.rs); the
 * UI zoom (`setZoom`) scales CSS pixels on top of that.
 */
async function positionScale(): Promise<number> {
  const win = getCurrentWindow();
  const [size, factor] = await Promise.all([win.innerSize(), win.scaleFactor()]);
  const physPerCss = size.width / window.innerWidth;
  return OS === "windows" ? physPerCss : physPerCss / factor;
}

let listeners = 0;
let stopListening: (() => void) | null = null;

/**
 * Listens for files dragged in from a file manager while at least one explorer is mounted (one
 * listener per window, so two explorers don't copy twice); returns the function to stop.
 */
export function listenExternalDrops(): () => void {
  if (listeners++ === 0) stopListening = listen();
  return () => {
    if (--listeners === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

let scale = 1;

/** CSS position → the explorer folder there (null: not over the local explorer). */
function folderAt(x: number, y: number): string | null {
  if (!app.root) return null;
  const el = document.elementFromPoint(x, y);
  return el?.closest(".files .tree") ? folderOf(el) : null;
}

type DragPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

/** One drag-drop event of the window (`position` as Tauri sends it). */
export async function handleDragDrop(payload: DragPayload) {
  const at = (p: { x: number; y: number }) => folderAt(p.x / scale, p.y / scale);
  if (payload.type === "enter") {
    scale = await positionScale().catch(() => window.devicePixelRatio || 1);
    externalDrop.target = at(payload.position);
  } else if (payload.type === "over") externalDrop.target = at(payload.position);
  else if (payload.type === "leave") externalDrop.target = null;
  else {
    const dir = at(payload.position);
    externalDrop.target = null;
    if (dir) await importFiles(payload.paths, dir);
  }
}

function listen(): () => void {
  let unlisten: (() => void) | undefined;
  let alive = true;
  try {
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => handleDragDrop(payload))
      .then((fn) => (alive ? (unlisten = fn) : fn()))
      .catch(() => {});
  } catch {
    // Not inside Tauri (unit tests).
  }
  return () => {
    alive = false;
    unlisten?.();
    externalDrop.target = null;
  };
}
