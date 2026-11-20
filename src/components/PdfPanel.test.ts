import { describe, expect, test, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../lib/fsWatch.svelte", () => ({ onFilesChanged: vi.fn() }));
vi.mock("../lib/tools.svelte", () => ({ ensureTools: vi.fn() }));
vi.mock("../lib/native", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/state.svelte", () => ({ app: {}, activeTab: () => null, openFile: vi.fn() }));
vi.mock("../lib/editor", () => ({ getView: () => null, getText: () => "" }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
const { destroy } = vi.hoisted(() => ({ destroy: vi.fn() }));
vi.mock("pdfjs-dist", () => {
  const vp = { width: 100, height: 140, convertToViewportRectangle: () => [0, 0, 0, 0] };
  const page = {
    getViewport: () => vp,
    render: () => ({ promise: Promise.resolve() }),
    getAnnotations: async () => [],
  };
  const doc = { numPages: 2, getPage: async () => page, destroy };
  return { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(doc) }) };
});

import PdfPanel from "./PdfPanel.svelte";
import { latex } from "../lib/latex/controller.svelte";

async function settle() {
  for (let i = 0; i < 20; i++) await tick();
  flushSync();
}

describe("PdfPanel", () => {
  test("clears the old pages when the PDF goes away (#53)", async () => {
    latex.available = true;
    latex.status = "ok";
    latex.pdf = "/tmp/main.pdf";
    latex.pdfVersion = 1;
    const target = document.createElement("div");
    document.body.appendChild(target);
    const c = mount(PdfPanel, { target });
    await settle();
    expect(target.querySelectorAll(".pages .page").length).toBe(2);

    // Switching to a .tex tab that has no PDF yet.
    latex.pdf = null;
    latex.status = "error";
    await settle();
    expect(target.querySelector(".empty")).not.toBeNull();
    expect(target.querySelectorAll(".pages .page").length).toBe(0);
    expect(destroy).toHaveBeenCalled();
    unmount(c);
  });
});
