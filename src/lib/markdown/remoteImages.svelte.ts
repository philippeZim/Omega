/**
 * Which Markdown files may load images from the web. A remote image tells its server the reader's IP
 * address and when the note was opened, so nothing loads until the user allows it.
 *
 * Only real files are stored. A shared doc ("collab:…") or an unsaved tab is allowed in its editor
 * state instead (livePreview.ts): a guest's choice stays on the guest and ends with the session.
 */
import { onGlobalChange } from "../windowStorage";

const KEY = "markdown.remoteImages";

export type ImageScope = "file" | "folder";

export const remoteImages = $state({ always: false, files: [] as string[], folders: [] as string[] });

const listeners = new Set<() => void>();

/** Runs `fn` whenever a permission changes, here or in another window. */
export function onRemoteImagesChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s !== "") : []);

/** Reads the stored permissions; anything malformed counts as not allowed. */
export function loadRemoteImages() {
  let raw: { always?: unknown; files?: unknown; folders?: unknown } | null = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    // Corrupt value: start over with nothing allowed.
  }
  remoteImages.always = raw?.always === true;
  remoteImages.files = strings(raw?.files);
  remoteImages.folders = strings(raw?.folders);
  for (const fn of [...listeners]) fn();
}

function save() {
  localStorage.setItem(KEY, JSON.stringify({ always: remoteImages.always, files: remoteImages.files, folders: remoteImages.folders }));
  for (const fn of [...listeners]) fn();
}

/** True for a file on disk, the only kind of path a permission can be stored for. */
export const isStoredPath = (path: string | null): path is string => !!path && !path.startsWith("collab:");

const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || "/";
const inside = (path: string, dir: string) => path === dir || path.startsWith(/[\\/]$/.test(dir) ? dir : dir + "/") || path.startsWith(dir + "\\");

/** The stored answer for this file; `always` applies to every document. */
export function imagesAllowed(path: string | null) {
  if (remoteImages.always) return true;
  if (!isStoredPath(path)) return false;
  return remoteImages.files.includes(path) || remoteImages.folders.some((d) => inside(path, d));
}

export function allowImages(path: string, scope: ImageScope) {
  if (!isStoredPath(path)) return;
  const list = scope === "file" ? remoteImages.files : remoteImages.folders;
  const entry = scope === "file" ? path : folderOf(path);
  if (!list.includes(entry)) list.push(entry);
  save();
}

export function setAlwaysAllowImages(on: boolean) {
  remoteImages.always = on;
  save();
}

/** A file or folder was renamed (`to`) or deleted (null): its permissions go with it. */
export function moveImagePermissions(from: string, to: string | null) {
  const move = (list: string[]) => {
    const out = list.flatMap((p) => (!inside(p, from) ? [p] : to === null ? [] : [to + p.slice(from.length)]));
    return [...new Set(out)];
  };
  const files = move(remoteImages.files), folders = move(remoteImages.folders);
  if (files.join("\0") === remoteImages.files.join("\0") && folders.join("\0") === remoteImages.folders.join("\0")) return;
  remoteImages.files = files;
  remoteImages.folders = folders;
  save();
}

/** The URL as the browser reads it: it drops spaces and control characters around and inside a scheme. */
const compact = (url: string) => url.replace(/[\u0000- ]/g, "");

/** An image the browser would fetch from the network. */
export const isRemoteImage = (url: string) => /^https?:/i.test(compact(url));

/** Any other scheme that isn't a local image kind: never handed to the browser. */
export const isForeignScheme = (url: string) => {
  const s = compact(url);
  return /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(https?|data|asset):/i.test(s) && !/^[a-z]:[\\/]/i.test(s);
};

/** The server name shown on the placeholder. */
export function imageHost(url: string) {
  try {
    return new URL(compact(url)).host || url;
  } catch {
    return url;
  }
}

loadRemoteImages();
onGlobalChange(KEY, loadRemoteImages);
