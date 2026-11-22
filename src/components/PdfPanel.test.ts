import { beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../lib/fsWatch.svelte", () => ({ onFilesChanged: vi.fn() }));
vi.mock("../lib/tools.svelte", () => ({ ensureTools: vi.fn() }));
vi.mock("../lib/native", () => ({ openUrl: vi.fn() }));
const st = vi.hoisted(() => ({ active: null as string | null, view: null as unknown, openFile: async (_p: string) => {} }));
vi.mock("../lib/state.svelte", () => ({ app: { root: "/p" }, activeTab: () => (st.active ? { path: st.active } : null), openFile: (p: string) => st.openFile(p) }));
vi.mock("../lib/editor", () => ({ getView: () => st.view, getText: () => "" }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

/** Fake pdf.js: every getDocument() gives a new doc; destroying it rejects its pending renders. */
const pdf = vi.hoisted(() => {
  const s = {
    hang: false,
    pages: 2,
    requested: [] as number[],
    docs: [] as { destroyed: boolean; destroy: () => void }[],
    make() {
      const pending: ((e: Error) => void)[] = [];
      const vp = { width: 100, height: 140, convertToViewportRectangle: () => [0, 0, 0, 0] };
      const page = {
        getViewport: () => vp,
        render: () => ({
          promise: s.hang ? new Promise<void>((_, reject) => pending.push(reject)) : Promise.resolve(),
          cancel: () => pending.splice(0).forEach((r) => r(new Error("cancelled"))),
        }),
        getAnnotations: async () => [],
        cleanup: () => {},
      };
      const doc = {
        numPages: s.pages,
        destroyed: false,
        getPage: async (n: number) => {
          s.requested.push(n);
          return page;
        },
        getPageIndex: async (ref: { num: number }) => ref.num,
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
const getDocument = vi.hoisted(() => vi.fn());
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument, PDFWorker: class {} }));

import PdfPanel from "./PdfPanel.svelte";
import * as controller from "../lib/latex/controller.svelte";
import { latex } from "../lib/latex/controller.svelte";

beforeEach(() => {
  getDocument.mockReset();
  getDocument.mockImplementation(() => ({ promise: Promise.resolve(pdf.make()) }));
});

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
    pdf.pages = 2;
    pdf.requested = [];
    latex.target = null;
    pdf.docs.length = 0;
    st.active = null;
    st.view = null;
    st.openFile = async () => {};
  });

  test("pdf.js doesn't decode images through OffscreenCanvas, which mixes up pages in WebKitGTK", async () => {
    const { c } = setup();
    await settle();
    expect(getDocument.mock.calls[0][0]).toMatchObject({ isOffscreenCanvasSupported: false, isEvalSupported: false });
    unmount(c);
  });

  test("diagnostics from other files show the file name (#142)", async () => {
    st.active = "/p/main.tex";
    const { target, c } = setup();
    latex.diagnostics = [
      { file: "/p/main.tex", line: 4, message: "A", severity: "error" },
      { file: "/p/chapters/broken.tex", line: 2, message: "B", severity: "error" },
      { file: "/elsewhere/x.sty", line: 1, message: "C", severity: "warning" },
      { file: "", line: 0, message: "D", severity: "error" },
    ];
    await settle();
    target.querySelector<HTMLButtonElement>("button.status")!.click();
    await settle();
    const files = [...target.querySelectorAll("button.diag")].map((b) => b.querySelector(".file")?.textContent ?? null);
    expect(files).toEqual([null, "chapters/broken.tex", "x.sty", null]);
    latex.diagnostics = [];
    unmount(c);
  });

  test("a diagnostic whose file fails to open doesn't jump in the current file (#141)", async () => {
    const dispatch = vi.fn();
    const doc = { lines: 10, line: (n: number) => ({ from: n * 10 }) };
    st.view = { state: { doc }, dispatch, focus: () => {} };
    st.active = "/p/main.tex";
    const { target, c } = setup();
    latex.diagnostics = [
      { file: "/p/chapters/missing", line: 2, message: "Undefined control sequence", severity: "error" },
      { file: "/p/chapters/one.tex", line: 3, message: "Overfull", severity: "warning" },
    ];
    await settle();
    target.querySelector<HTMLButtonElement>("button.status")!.click();
    await settle();
    const diags = target.querySelectorAll<HTMLButtonElement>("button.diag");
    // Opening fails (toast in openFile), the active tab stays main.tex: no jump.
    diags[0].click();
    await settle();
    expect(dispatch).not.toHaveBeenCalled();
    // Opening works: the jump happens in the newly active file.
    st.openFile = async (p) => void (st.active = p);
    diags[1].click();
    await settle();
    expect(st.active).toBe("/p/chapters/one.tex");
    expect(dispatch).toHaveBeenCalledWith({ selection: { anchor: 30 }, scrollIntoView: true });
    latex.diagnostics = [];
    unmount(c);
  });

  test("a long document mounts and loads only the pages near the view", async () => {
    pdf.pages = 1500;
    const { target, c } = setup();
    await settle();
    expect(target.querySelectorAll(".pages .page").length).toBeLessThan(25);
    expect(pdf.requested.length).toBeLessThan(25);
    unmount(c);
  });

  test("forward SyncTeX reaches a page that isn't mounted and flashes the box there", async () => {
    pdf.pages = 1500;
    const { target, c } = setup();
    await settle();
    expect(target.querySelector('[data-page="900"]')).toBeNull();
    latex.target = { page: 900, x: 10, y: 20, w: 5, h: 5, seq: 1 };
    await settle();
    expect(pdf.requested).toContain(900);
    expect(target.querySelector('[data-page="900"]')).not.toBeNull();
    const box = target.querySelector<HTMLElement>(".flash")!;
    const holder = target.querySelector<HTMLElement>('[data-page="900"]')!.parentElement!;
    expect(parseFloat(box.style.top)).toBeCloseTo(parseFloat(holder.style.top) + 20 * 0.3 - 3);
    latex.target = null;
    unmount(c);
  });

  test("reverse SyncTeX works on a mounted page of a long document", async () => {
    pdf.pages = 1500;
    const sync = vi.spyOn(controller, "reverseSync").mockReturnValue(null);
    const { target, c } = setup();
    await settle();
    const page = target.querySelector<HTMLElement>('[data-page="2"]')!;
    page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 280 }) as DOMRect;
    page.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 50, clientY: 70 }));
    await settle();
    expect(sync).toHaveBeenCalledWith(2, 25, 35); // 2 px per PDF unit
    sync.mockRestore();
    unmount(c);
  });

  test("a recompile keeps the view and the old bitmap until the new one is ready", async () => {
    pdf.pages = 1500;
    const { target, c } = setup();
    await settle();
    const scroller = target.querySelector<HTMLElement>(".scroller")!;
    scroller.scrollTop = 20_000;
    scroller.dispatchEvent(new Event("scroll"));
    await settle();
    const page = [...target.querySelectorAll<HTMLElement>(".page")].find((p) => p.querySelector("canvas"))!;
    const old = page.querySelector("canvas")!;
    const before = pdf.requested.length;
    pdf.hang = true;
    latex.pdfVersion = 2;
    await settle();
    expect(scroller.scrollTop).toBeCloseTo(20_000, -1);
    expect(page.isConnected).toBe(true);
    expect(page.querySelector("canvas")).toBe(old); // not blank while the new version renders
    expect(pdf.requested.length - before).toBeLessThan(25); // not the whole document
    pdf.hang = false;
    latex.pdfVersion = 3;
    for (let i = 0; i < 12 && page.querySelector("canvas") === old; i++) await settle();
    expect(page.querySelector("canvas")).not.toBe(old);
    expect(pdf.docs.at(-2)!.destroyed).toBe(true);
    unmount(c);
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
