// Backend events for this window. A plain `listen` also receives events sent to other windows
// (Tauri matches a listener without a target against every target), so all listeners go here.
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

/** Label of this window; null outside Tauri (tests). */
export function windowLabel(): string | null {
  const meta = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__?.metadata;
  return meta?.currentWindow?.label ?? null;
}

export function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const label = windowLabel();
  return label ? tauriListen<T>(event, handler, { target: { kind: "WebviewWindow", label } }) : tauriListen<T>(event, handler);
}
