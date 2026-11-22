import { beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.mock("../lib/native", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/api", () => ({ fsApi: { readFileRange: vi.fn(async () => new Uint8Array()) } }));
vi.mock("../lib/i18n/index.svelte", () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${p.page}/${p.total}` : k) }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

/** Fake pdf.js: 3000 pages of 100x200, except page 2500 (100x400). Renders finish when released. */
const pdf = vi.hoisted(() => {
  const s = {
    pages: 3000,
    requested: [] as number[],
    rendered: [] as number[],
    cancelled: [] as number[],
    cleaned: [] as number[],
    destroyed: 0,
    manual: false,
    pending: [] as { n: number; done: () => void; fail: (e: Error) => void }[],
    annots: {} as Record<number, unknown[]>,
    page(n: number) {
      const h = n === 2500 ? 400 : 200;
      return {
        getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: h * scale, scale, convertToViewportRectangle: () => [0, 0, 10, 10] }),
        render: () => {
          s.rendered.push(n);
          let done = () => {};
          let fail = (_e: Error) => {};
          const promise = new Promise<void>((res, rej) => {
            done = res;
            fail = rej;
          });
          const job = { n, done, fail };
          if (s.manual) s.pending.push(job);
          else done();
          return {
            promise,
            cancel() {
              s.cancelled.push(n);
              const e = new Error("cancelled");
              e.name = "RenderingCancelledException";
              fail(e);
            },
          };
        },
        getAnnotations: async () => s.annots[n] ?? [],
        cleanup: () => void s.cleaned.push(n),
      };
    },
    doc() {
      return {
        numPages: s.pages,
        getPage: async (n: number) => {
          s.requested.push(n);
          return s.page(n);
        },
        getPageIndex: async (ref: { num: number }) => ref.num,
        getDestination: async () => null,
        destroy: async () => void s.destroyed++,
      };
    },
  };
  return s;
});
const getDocument = vi.hoisted(() => vi.fn());
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument, PDFWorker: class {}, PDFDataRangeTransport: class {} }));

import PdfView from "./PdfView.svelte";
import { forgetViewer } from "../lib/viewerMemory";

async function settle() {
  for (let i = 0; i < 40; i++) await tick();
  flushSync();
  for (let i = 0; i < 40; i++) await tick();
}

Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 400; } });
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 132; } }); // scale 1

async function view() {
  const target = document.createElement("div");
  document.body.append(target);
  const cmp = mount(PdfView, { target, props: { source: { path: "/p/a.pdf", size: 1000 } } });
  flushSync();
  await settle();
  return { target, scroller: target.querySelector<HTMLElement>(".scroller")!, cmp };
}
const scrollTo = async (el: HTMLElement, y: number) => {
  el.scrollTop = y;
  el.dispatchEvent(new Event("scroll"));
  await settle();
};
/** Page tops at scale 1: 16 + (200 + 14) per page. */
const topOf = (page: number) => 16 + (page - 1) * 214;

beforeEach(() => {
  getDocument.mockReset();
  getDocument.mockImplementation(() => ({ promise: Promise.resolve(pdf.doc()), destroy: async () => void pdf.destroyed++ }));
  Object.assign(pdf, { requested: [], rendered: [], cancelled: [], cleaned: [], destroyed: 0, manual: false, pending: [], annots: {} });
  document.body.replaceChildren();
});

test("a huge PDF shows its count with only the pages near the view in the DOM", async () => {
  const { target, cmp } = await view();
  expect(target.querySelector(".info")!.textContent).toContain("/3000");
  expect(target.querySelectorAll(".page").length).toBeLessThan(10);
  expect(pdf.requested.length).toBeLessThan(10);
  unmount(cmp);
});

test("the file is read on demand, with the safe pdf.js options", async () => {
  const { cmp } = await view();
  const o = getDocument.mock.calls[0][0];
  expect(o).toMatchObject({ isOffscreenCanvasSupported: false, isEvalSupported: false, disableAutoFetch: true, disableStream: true });
  expect(o.range).toBeDefined();
  expect(o.data).toBeUndefined();
  expect(o.worker).toBeDefined();
  unmount(cmp);
});

test("all documents share one pdf.js worker", async () => {
  const a = await view();
  const b = await view();
  expect(getDocument.mock.calls[0][0].worker).toBe(getDocument.mock.calls[1][0].worker);
  unmount(a.cmp);
  unmount(b.cmp);
});

test("only one page renders at a time, the visible one first", async () => {
  pdf.manual = true;
  const { scroller, cmp } = await view();
  await scrollTo(scroller, topOf(1000));
  pdf.pending.splice(0).forEach((j) => j.done());
  await settle();
  expect(pdf.pending).toHaveLength(1);
  expect(pdf.rendered.at(-1)).toBe(1000 + 1); // view centre lies on the next page
  unmount(cmp);
});

test("a render that scrolled out of reach is cancelled", async () => {
  pdf.manual = true;
  const { scroller, cmp } = await view();
  expect(pdf.rendered).toEqual([1]);
  await scrollTo(scroller, topOf(2000));
  expect(pdf.cancelled).toEqual([1]);
  expect(pdf.rendered.at(-1)).toBeGreaterThan(1999);
  unmount(cmp);
});

test("far pages are let go of and unmounted", async () => {
  const { target, scroller, cmp } = await view();
  for (const p of [500, 1000, 1500, 2000]) await scrollTo(scroller, topOf(p));
  expect(target.querySelector('[data-page="1"]')).toBeNull();
  expect(target.querySelectorAll(".page").length).toBeLessThan(10);
  unmount(cmp);
});

test("a zoom keeps the old bitmap on screen until the new one is ready", async () => {
  const { target, cmp } = await view();
  await new Promise((r) => setTimeout(r, 0));
  const page = target.querySelector<HTMLElement>('[data-page="1"]')!;
  const old = page.querySelector("canvas")!;
  expect(old).not.toBeNull();
  pdf.manual = true;
  target.querySelectorAll<HTMLElement>(".zoom .tool.round")[1].click();
  await settle();
  expect(page.querySelector("canvas")).toBe(old); // scaled, not blank
  await new Promise((r) => setTimeout(r, 140));
  await settle();
  expect(page.querySelector("canvas")).toBe(old); // still rendering the sharp one
  const job = pdf.pending.find((j) => j.n === 1)!;
  job.done();
  await settle();
  expect(page.querySelector("canvas")).not.toBe(old);
  unmount(cmp);
});

test("a link to a page not loaded yet lands on it, and its real size corrects the layout", async () => {
  pdf.annots[1] = [{ subtype: "Link", dest: [2499, { name: "XYZ" }, 0, 400, 0], rect: [0, 0, 1, 1] }];
  const { target, scroller, cmp } = await view();
  expect(pdf.requested).not.toContain(2500);
  target.querySelector<HTMLElement>(".page a.link")!.click();
  await settle();
  expect(pdf.requested).toContain(2500);
  expect(scroller.scrollTop).toBe(topOf(2500) - 12);
  const shell = target.querySelector<HTMLElement>('[data-page="2500"]')!.parentElement!;
  expect(parseFloat(shell.style.height)).toBeCloseTo(400);
  expect(target.querySelector(".info")!.textContent).toContain("2500/3000");
  unmount(cmp);
});

test("closing the tab during load stops it", async () => {
  let resolve = (_d: unknown) => {};
  const destroy = vi.fn(async () => {});
  getDocument.mockImplementation(() => ({ promise: new Promise((r) => (resolve = r)), destroy }));
  const { cmp } = await view();
  unmount(cmp);
  expect(destroy).toHaveBeenCalled();
  resolve(pdf.doc());
  await settle();
  expect(pdf.requested).toEqual([]);
});

test("a corrupt PDF shows the message", async () => {
  getDocument.mockImplementation(() => ({ promise: Promise.reject(new Error("bad")), destroy: async () => {} }));
  const { target, cmp } = await view();
  expect(target.querySelector('[role="alert"]')!.textContent).toContain("app.viewer.brokenPdf");
  unmount(cmp);
});

test("a file that changed under the open document shows a translated message and asks its tab to check", async () => {
  const onReadFailed = vi.fn();
  const target = document.createElement("div");
  document.body.append(target);
  const cmp = mount(PdfView, { target, props: { source: { path: "/p/a.pdf", size: 1000 }, onReadFailed } });
  flushSync();
  await settle();
  const transport = getDocument.mock.calls[0][0].range;
  const { fsApi } = await import("../lib/api");
  vi.mocked(fsApi.readFileRange).mockResolvedValueOnce(new Uint8Array(1)); // shorter than asked for
  transport.requestDataRange(0, 10);
  await new Promise((r) => setTimeout(r, 0));
  await settle();
  expect(target.querySelector('[role="alert"]')!.textContent).toContain("app.viewer.brokenPdf");
  expect(onReadFailed).toHaveBeenCalledTimes(1);
  unmount(cmp);
});

describe("a tab switch", () => {
  const open = async (tabId: string) => {
    const target = document.createElement("div");
    document.body.append(target);
    const cmp = mount(PdfView, { target, props: { tabId, source: { path: `/p/${tabId}.pdf`, size: 1000 } } });
    flushSync();
    await settle();
    return { target, cmp, scroller: target.querySelector<HTMLElement>(".scroller")! };
  };

  test("returns to the same page and zoom", async () => {
    forgetViewer("t1");
    const a = await open("t1");
    a.target.querySelectorAll<HTMLElement>(".zoom .tool.round")[1].click(); // 125 %
    await settle();
    await scrollTo(a.scroller, 1000 * (250 + 14) + 40);
    const page = a.target.querySelector(".info")!.textContent;
    const top = a.scroller.scrollTop;
    unmount(a.cmp);
    pdf.requested = [];
    const b = await open("t1");
    expect(b.target.querySelector(".pct")!.textContent).toContain("125");
    expect(b.scroller.scrollTop).toBeCloseTo(top, 0);
    expect(b.target.querySelector(".info")!.textContent).toBe(page);
    expect(pdf.requested.filter((n) => n > 1 && n < 900)).toEqual([]); // nothing between the start and the place
    unmount(b.cmp);
    forgetViewer("t1");
  });

  test("each tab has its own place, and a closed tab has none", async () => {
    forgetViewer("t2");
    forgetViewer("t3");
    const a = await open("t2");
    await scrollTo(a.scroller, topOf(500));
    unmount(a.cmp);
    const b = await open("t3");
    expect(b.scroller.scrollTop).toBe(0);
    unmount(b.cmp);
    forgetViewer("t2");
    const c = await open("t2");
    expect(c.scroller.scrollTop).toBe(0);
    unmount(c.cmp);
    forgetViewer("t2");
    forgetViewer("t3");
  });

  test("a hidden tab holds no canvas and does no work", async () => {
    forgetViewer("t4");
    const a = await open("t4");
    const canvases = [...a.target.querySelectorAll("canvas")];
    expect(canvases.length).toBeGreaterThan(0);
    unmount(a.cmp);
    expect(canvases.every((c) => c.width === 0)).toBe(true);
    const n = pdf.rendered.length;
    await new Promise((r) => setTimeout(r, 160));
    expect(pdf.rendered.length).toBe(n);
    expect(pdf.destroyed).toBeGreaterThan(0);
    forgetViewer("t4");
  });
});
