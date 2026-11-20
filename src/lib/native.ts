/**
 * Native file dialogs and the system opener (browser, file manager), behind one switch: test
 * instances (OMEGA_INSTANCE) run on an invisible desktop, but native windows would open on the
 * user's desktop. There `sandboxNative()` (control MCP) reroutes them into the app.
 */
import { open, save, type OpenDialogOptions, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { openUrl as sysOpenUrl, revealItemInDir as sysReveal } from "@tauri-apps/plugin-opener";

export interface NativeSandbox {
  /** Replaces a file dialog; returns the chosen path(s) or null. */
  dialog(kind: "open file" | "open folder" | "save file", options: OpenDialogOptions | SaveDialogOptions): Promise<string | string[] | null>;
  /** Replaces opening a URL / revealing a path. */
  open(what: string): void;
}

let sandbox: NativeSandbox | null = null;
export function sandboxNative(s: NativeSandbox | null) {
  sandbox = s;
}

export function openDialog<T extends OpenDialogOptions>(options: T) {
  if (sandbox) return sandbox.dialog(options.directory ? "open folder" : "open file", options) as ReturnType<typeof open<T>>;
  return open(options);
}

export function saveDialog(options: SaveDialogOptions = {}): Promise<string | null> {
  if (sandbox) return sandbox.dialog("save file", options) as Promise<string | null>;
  return save(options);
}

export async function openUrl(url: string | URL, openWith?: string) {
  if (sandbox) return sandbox.open(String(url));
  return sysOpenUrl(url, openWith);
}

export async function revealItemInDir(path: string | string[]) {
  if (sandbox) return sandbox.open(`reveal ${path}`);
  return sysReveal(path);
}
