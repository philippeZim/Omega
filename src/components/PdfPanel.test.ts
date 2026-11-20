import { beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../lib/fsWatch.svelte", () => ({ onFilesChanged: vi.fn() }));
vi.mock("../lib/tools.svelte", () => ({ ensureTools: vi.fn() }));
vi.mock("../lib/native", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/state.svelte", () => ({ app: {}, activeTab: () => null, openFile: vi.fn() }));
vi.mock("../lib/editor", () => ({ getView: () => null, getText: () => "" }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

/** Fake pdf.js: every getDocument() gives a new doc; destroying it rejects its pending renders. */
const pdf = vi.hoisted(() => {
  const s = {
    hang: false,
    docs: [] as { destroyed: boolean; destroy: () => void }[],
    make() {
      const pending: ((e: Error) => void)[] = [];
      const vp = { width: 100, height: 140, convertToViewportRectangle: () => [0, 0, 0, 0] };
      const page = {
        getViewport: () => vp,
        render: () => ({
          promise: s.hang ? new Promise<void>((_, reject) => pending.push(reject)) : Promise.resolve(),
        }),
        getAnnotations: async () => [],
      };
      const doc = {
        numPages: 2,
        destroyed: false,
        getPage: async () => page,
        destroy() {
          doc.destroyed = true;
          pending.splice(0).forEach((r) => r(new Error("Worker was destroyed")));
        },
      };
      s.docs.push(doc);
      return doc;
    },
  };
  return s;
});
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(pdf.make()) }) }));

import PdfPanel from "./PdfPanel.svelte";
import { latex } from "../lib/latex/controller.svelte";

async function settle() {
  for (let i = 0; i < 20; i++) await tick();
  flushSync();
}

function setup() {
  latex.available = true;
  latex.status = "ok";
  latex.pdf = "/tmp/main.pdf";
  latex.pdfVersion = 1;
  const target = document.createElement("div");
  document.body.appendChild(target);
  return { target, c: mount(PdfPanel, { target }) };
}

describe("PdfPanel", () => {
  beforeEach(() => {
    pdf.hang = false;
    pdf.docs.length = 0;
  });

  test("clears the old pages when the PDF goes away (#53)", async () => {
    const { target, c } = setup();
    await settle();
    expect(target.querySelectorAll(".pages .page").length).toBe(2);

    // Switching to a .tex tab that has no PDF yet.
    latex.pdf = null;
    latex.status = "error";
    await settle();
    expect(target.querySelector(".empty")).not.toBeNull();
    expect(target.querySelectorAll(".pages .page").length).toBe(0);
    expect(pdf.docs[0].destroyed).toBe(true);
    unmount(c);
  });

  test("clearing during a render neither rejects unhandled nor leaks the previous doc", async () => {
    const { target, c } = setup();
    await settle();
    expect(pdf.docs.length).toBe(1);

    // A recompile starts loading doc 2 whose render hangs, then the PDF goes away.
    pdf.hang = true;
    latex.pdfVersion = 2;
    await settle();
    expect(pdf.docs.length).toBe(2);
    latex.pdf = null;
    await settle();
    expect(pdf.docs.map((d) => d.destroyed)).toEqual([true, true]);
    expect(target.querySelectorAll(".pages .page").length).toBe(0);
    unmount(c);
  });
});
