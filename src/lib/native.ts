/**
 * Native file dialogs and the system opener (browser, file manager), behind one switch: test
 * instances (OMEGA_INSTANCE) run on an invisible desktop, but native windows would open on the
 * user's desktop. There `sandboxNative()` (control MCP) reroutes them into the app.
 */
import { invoke } from "@tauri-apps/api/core";
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
  if (openWith) return sysOpenUrl(url, openWith);
  return invoke<void>("open_external", { url: String(url) });
}

/** Links that want a new window open in the browser (replaces the opener plugin's click script). */
export function linkTarget(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.altKey) return null;
  const a = e.composedPath().find((n) => n instanceof Node && n.nodeName.toUpperCase() === "A") as HTMLAnchorElement | undefined;
  const target = a?.getAttribute("target") ?? a?.ownerDocument.querySelector("base[target]")?.getAttribute("target");
  if (!a?.href || (target !== "_blank" && !e.ctrlKey && !e.shiftKey)) return null;
  const url = new URL(a.href);
  return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
}

if (typeof window !== "undefined") {
  window.addEventListener("click", (e) => {
    const url = linkTarget(e);
    if (!url) return;
    e.preventDefault();
    void openUrl(url);
  });
}

export async function revealItemInDir(path: string | string[]) {
  if (sandbox) return sandbox.open(`reveal ${path}`);
  return sysReveal(path);
}
