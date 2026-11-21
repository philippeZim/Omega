import { afterEach, describe, expect, it, vi } from "vitest";

const tauriListen = vi.hoisted(() => vi.fn(async () => () => {}));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriListen }));

import { listen } from "./windowEvents";

const internals = window as unknown as { __TAURI_INTERNALS__?: unknown };

const sources = import.meta.glob(["/src/**/*.ts", "/src/**/*.svelte", "!/src/**/*.test.ts", "!/src/lib/windowEvents.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("window events", () => {
  const saved = internals.__TAURI_INTERNALS__;
  afterEach(() => {
    internals.__TAURI_INTERNALS__ = saved;
    tauriListen.mockClear();
  });

  it("listens only to events for this window", async () => {
    internals.__TAURI_INTERNALS__ = { ...(saved as object), metadata: { currentWindow: { label: "w-a" } } };
    const h = () => {};
    await listen("pty-data", h);
    expect(tauriListen).toHaveBeenCalledWith("pty-data", h, { target: { kind: "WebviewWindow", label: "w-a" } });
  });

  it("no module listens to the backend without the window filter", () => {
    const offenders = Object.keys(sources).filter((p) => /import\s*\{[^}]*\blisten\b[^}]*\}\s*from\s*"@tauri-apps\/api\/event"/.test(sources[p]));
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
