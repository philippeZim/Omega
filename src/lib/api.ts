import { invoke } from "@tauri-apps/api/core";

export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Replaces lone UTF-16 surrogates with U+FFFD. They have no UTF-8 encoding, so the IPC payload (and with
 *  it every save) would fail. Same as String.prototype.toWellFormed(), which ES2022 / older WebKit lack. */
export const wellFormed = (s: string) => s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "�"));

export const fsApi = {
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content: wellFormed(content) }),
  writeFileBase64: (path: string, data: string) => invoke<void>("write_file_base64", { path, data }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  remove: (path: string) => invoke<void>("delete_path", { path }),
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
