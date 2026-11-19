import { invoke } from "@tauri-apps/api/core";

export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const fsApi = {
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  remove: (path: string) => invoke<void>("delete_path", { path }),
  exists: (path: string) => invoke<boolean>("path_exists", { path }),
  homeDir: () => invoke<string>("home_dir"),
};

export const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
export const dirname = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";
export const joinPath = (a: string, b: string) => (a.endsWith("/") ? a + b : `${a}/${b}`);
export const extname = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
};
