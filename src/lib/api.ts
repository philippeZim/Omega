import { invoke } from "@tauri-apps/api/core";
import { fsErrorText } from "./fsError";

export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Replaces lone UTF-16 surrogates with U+FFFD. They have no UTF-8 encoding, so the IPC payload (and with
 *  it every save) would fail. Same as String.prototype.toWellFormed(), which ES2022 / older WebKit lack. */
export const wellFormed = (s: string) => s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "�"));

/** Runs a file command; its error codes become translated messages naming `path` (#33). */
const fsCall = <T>(cmd: string, args: Record<string, unknown>, path: string) =>
  invoke<T>(cmd, args).catch((e) => {
    throw fsErrorText(e, path);
  });

export const fsApi = {
  listDir: (path: string) => fsCall<Entry[]>("list_dir", { path }, path),
  readFile: (path: string) => fsCall<string>("read_file", { path }, path),
  /** The start of a file too large for readFile (#174). */
  readFileHead: (path: string) => fsCall<{ text: string; size: number }>("read_file_head", { path }, path),
  /** A whole file of up to 64 MiB, for a tab the user chose to open despite the warning (#174). */
  readFileLarge: (path: string) =>
    // ignoreBOM keeps the mark in the text: eol.ts remembers it and save writes it back.
    fsCall<ArrayBuffer>("read_file_large", { path }, path).then((b) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b)),
  /** The raw bytes of an image or PDF for a viewer tab, up to 64 MiB. */
  readFileView: (path: string) => fsCall<ArrayBuffer>("read_file_view", { path }, path).then((b) => new Uint8Array(b)),
  /** A piece of a PDF, at most 4 MiB. Rejects with "fs:changed" if the file no longer has this size and time. */
  readFileRange: (path: string, offset: number, length: number, size: number, modified: number) =>
    fsCall<ArrayBuffer>("read_file_range", { path, offset, length, size, modified }, path).then((b) => new Uint8Array(b)),
  /** Size and change time of a file. `too_large`: readFile refuses it; `preview`: readFileLarge does too. */
  fileInfo: (path: string) => fsCall<{ size: number; too_large: boolean; preview: boolean; modified: number }>("file_info", { path }, path),
  writeFile: (path: string, content: string) => fsCall<void>("write_file", { path, content: wellFormed(content) }, path),
  /** Creates an empty file; rejects if it already exists (never truncates). */
  createFile: (path: string) => fsCall<void>("create_file", { path }, path),
  writeFileBase64: (path: string, data: string) => fsCall<void>("write_file_base64", { path, data }, path),
  createDir: (path: string) => fsCall<void>("create_dir", { path }, path),
  // "exists" and "outside_project" are about the target, every other error about the source.
  rename: (from: string, to: string) =>
    invoke<void>("rename_path", { from, to }).catch((e) => {
      throw fsErrorText(e, ["fs:exists", "fs:outside_project"].includes(String(e)) ? to : from);
    }),
  remove: (path: string) => fsCall<void>("delete_path", { path }, path),
  exists: (path: string) => invoke<boolean>("path_exists", { path }),
  homeDir: () => invoke<string>("home_dir"),
};

/** Normalises an OS path for the frontend: "/" separators ("C:\\x" → "C:/x"). */
export const normPath = (p: string) => (/^[A-Za-z]:[\\/]|^\\\\/.test(p) ? p.replace(/\\/g, "/") : p);
/** "/" or a Windows drive root like "C:/". */
export const isRoot = (p: string) => p === "/" || /^[A-Za-z]:\/?$/.test(p);
/** Absolute path (POSIX "/x" or Windows "C:/x"). */
export const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
export const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
export const dirname = (p: string) => {
  const d = p.replace(/\/[^/]+\/?$/, "");
  if (/^[A-Za-z]:$/.test(d)) return d + "/";
  return d || "/";
};
export const joinPath = (a: string, b: string) => (a.endsWith("/") ? a + b : `${a}/${b}`);
export const extname = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
};
