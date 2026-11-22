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
import { forgetViewer, rememberViewer } from "../lib/viewerMemory";

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
  const cmp = mount(PdfView, { target, props: { source: { path: "/p/a.pdf", size: 1000, modified: 1 } } });
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
  for (let p = 100; p <= 2000; p += 100) await scrollTo(scroller, topOf(p));
  expect(target.querySelector('[data-page="1"]')).toBeNull();
  expect(target.querySelectorAll(".page").length).toBeLessThan(18); // near the view + the few kept
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

test("a file that changed under the open document keeps the view and asks for a reload", async () => {
  const onReadFailed = vi.fn();
  const target = document.createElement("div");
  document.body.append(target);
  const cmp = mount(PdfView, { target, props: { source: { path: "/p/a.pdf", size: 1000, modified: 1 }, onReadFailed } });
  flushSync();
  await settle();
  const transport = getDocument.mock.calls[0][0].range;
  const { fsApi } = await import("../lib/api");
  vi.mocked(fsApi.readFileRange).mockRejectedValueOnce("fs:changed");
  transport.requestDataRange(0, 10);
  await new Promise((r) => setTimeout(r, 0));
  await settle();
  expect(onReadFailed).toHaveBeenCalledExactlyOnceWith(true);
  expect(target.querySelector('[role="alert"]')).toBeNull();
  expect(target.querySelector(".page canvas")).not.toBeNull();
  unmount(cmp);
});

test("a read that fails for another reason shows the message", async () => {
  const onReadFailed = vi.fn();
  const target = document.createElement("div");
  document.body.append(target);
  const cmp = mount(PdfView, { target, props: { source: { path: "/p/a.pdf", size: 1000, modified: 1 }, onReadFailed } });
  flushSync();
  await settle();
  const transport = getDocument.mock.calls[0][0].range;
  const { fsApi } = await import("../lib/api");
  vi.mocked(fsApi.readFileRange).mockRejectedValueOnce("denied");
  transport.requestDataRange(0, 10);
  await new Promise((r) => setTimeout(r, 0));
  await settle();
  expect(target.querySelector('[role="alert"]')!.textContent).toContain("app.viewer.brokenPdf");
  expect(onReadFailed).toHaveBeenCalledExactlyOnceWith(false);
  unmount(cmp);
});

test("a failed render drops the old version's bitmap, and a new zoom tries again", async () => {
  const props = $state({ source: { path: "/p/a.pdf", size: 1000, modified: 1 } });
  const target = document.createElement("div");
  document.body.append(target);
  const cmp = mount(PdfView, { target, props });
  flushSync();
  await settle();
  const page = target.querySelector<HTMLElement>('[data-page="1"]')!;
  const old = page.querySelector("canvas")!;
  pdf.manual = true;
  props.source = { path: "/p/a.pdf", size: 1000, modified: 2 };
  flushSync();
  await settle();
  expect(page.querySelector("canvas")).toBe(old); // still there while the new version renders
  pdf.pending.find((j) => j.n === 1)!.fail(new Error("bad page"));
  await settle();
  expect(page.querySelector("canvas")).toBeNull();
  expect(page.querySelector(".page-error")!.textContent).toContain("app.viewer.pageFailed");
  pdf.pending = [];
  target.querySelectorAll<HTMLElement>(".zoom .tool.round")[1].click();
  await settle();
  await new Promise((r) => setTimeout(r, 140));
  await settle();
  pdf.pending.find((j) => j.n === 1)!.done();
  await settle();
  expect(page.querySelector("canvas")).not.toBeNull();
  expect(page.querySelector(".page-error")).toBeNull();
  unmount(cmp);
});

describe("a tab switch", () => {
  const open = async (tabId: string) => {
    const target = document.createElement("div");
    document.body.append(target);
    const cmp = mount(PdfView, { target, props: { tabId, source: { path: `/p/${tabId}.pdf`, size: 1000, modified: 1 } } });
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

  test("after a failed read the reopen goes to the latest place, not the one at mount", async () => {
    forgetViewer("t5");
    rememberViewer("t5", { zoom: 0, anchor: { page: 10, fraction: 0 } });
    const props = $state({ tabId: "t5", source: { path: "/p/t5.pdf", size: 1000, modified: 1 } });
    const target = document.createElement("div");
    document.body.append(target);
    const cmp = mount(PdfView, { target, props });
    flushSync();
    await settle();
    const scroller = target.querySelector<HTMLElement>(".scroller")!;
    await scrollTo(scroller, topOf(700));
    const transport = getDocument.mock.calls.at(-1)![0].range;
    const { fsApi } = await import("../lib/api");
    vi.mocked(fsApi.readFileRange).mockRejectedValueOnce("denied");
    transport.requestDataRange(0, 10);
    await new Promise((r) => setTimeout(r, 0));
    await settle();
    props.source = { path: "/p/t5.pdf", size: 1000, modified: 2 };
    flushSync();
    await settle();
    expect(target.querySelector(".scroller")!.scrollTop).toBe(topOf(700));
    unmount(cmp);
    forgetViewer("t5");
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

test("fit width accounts for the scrollbar the document itself brings", async () => {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")!;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.querySelector<HTMLElement>(":scope > .pages")?.style.height ? 122 : 132;
    },
  });
  try {
    const { target, cmp } = await view();
    const holder = target.querySelector<HTMLElement>('[data-page="1"]')!.parentElement!;
    expect(parseFloat(holder.style.width)).toBeCloseTo(90); // 122 - 32, not 132 - 32
    unmount(cmp);
  } finally {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
  }
});

describe("scrolling back and forth", () => {
  test("a scroll position that came without a scroll event still gets its pages", async () => {
    const { target, scroller, cmp } = await view();
    scroller.scrollTop = topOf(1500); // WebKit doesn't always deliver the event
    await new Promise((r) => setTimeout(r, 170));
    await settle();
    expect(target.querySelector('[data-page="1500"] canvas')).not.toBeNull();
    expect(target.querySelector(".info")!.textContent).toContain("/3000");
    unmount(cmp);
  });

  test("a rendered page stays in the DOM with its canvas, and returning renders nothing", async () => {
    const { target, scroller, cmp } = await view();
    const canvas = target.querySelector<HTMLCanvasElement>('[data-page="1"] canvas')!;
    await scrollTo(scroller, topOf(20));
    expect(canvas.isConnected).toBe(true); // never taken out of the DOM and put back
    const before = pdf.rendered.filter((n) => n === 1).length;
    await scrollTo(scroller, 0);
    expect(target.querySelector('[data-page="1"] canvas')).toBe(canvas);
    expect(canvas.width).toBeGreaterThan(0);
    expect(pdf.rendered.filter((n) => n === 1).length).toBe(before);
    unmount(cmp);
  });

  test("reversing while renders are in flight leaves every page in view rendered", async () => {
    pdf.manual = true;
    const { target, scroller, cmp } = await view();
    for (let round = 0; round < 40; round++) {
      await scrollTo(scroller, topOf(1 + ((round * 37) % 11) * (round % 3 ? 1 : 90)));
      if (round % 2) pdf.pending.splice(0, 1).forEach((j) => j.done());
    }
    await scrollTo(scroller, topOf(30));
    pdf.manual = false;
    pdf.pending.splice(0).forEach((j) => j.done());
    for (let i = 0; i < 30; i++) {
      await settle();
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const p of [30, 31]) expect(target.querySelector(`[data-page="${p}"] canvas`)).not.toBeNull();
    unmount(cmp);
  });

  test("the pager stops watching when the view closes", async () => {
    const stop = vi.spyOn(window, "clearInterval");
    const { cmp } = await view();
    unmount(cmp);
    expect(stop).toHaveBeenCalled();
    stop.mockRestore();
  });
});

describe("a document long enough to compress", () => {
  const open = async () => {
    forgetViewer("long");
    rememberViewer("long", { zoom: 4, anchor: { page: 2900, fraction: 0 } }); // 3000 x 800 px is near the limit
    pdf.pages = 30_000;
    const target = document.createElement("div");
    document.body.append(target);
    const cmp = mount(PdfView, { target, props: { tabId: "long", source: { path: "/p/long.pdf", size: 1000, modified: 1 } } });
    flushSync();
    await settle();
    return { target, cmp, scroller: target.querySelector<HTMLElement>(".scroller")! };
  };
  const finish = (cmp: Record<string, unknown>) => {
    unmount(cmp);
    forgetViewer("long");
    pdf.pages = 3000;
  };

  test("pages far from the view aren't kept, so they can't stretch the scroll range", async () => {
    const { target, scroller, cmp } = await open();
    const spacer = target.querySelector<HTMLElement>(".pages")!;
    const height = spacer.style.height;
    await scrollTo(scroller, parseFloat(height) - 400); // the end
    expect(target.querySelector('[data-page="30000"]')).not.toBeNull();
    await scrollTo(scroller, 0); // the start
    expect(target.querySelector('[data-page="30000"]')).toBeNull();
    expect(spacer.style.height).toBe(height);
    expect(spacer.style.overflow).toBe("hidden");
    for (const h of target.querySelectorAll<HTMLElement>(".slot")) expect(Math.abs(parseFloat(h.style.top))).toBeLessThan(3 * 400 + 2 * 814);
    finish(cmp);
  });

  test("an uncompressed document keeps its rendered pages mounted", async () => {
    const { target, scroller, cmp } = await view();
    expect(target.querySelector<HTMLElement>(".pages")!.style.overflow).toBe("");
    await scrollTo(scroller, topOf(20));
    expect(target.querySelector('[data-page="1"]')).not.toBeNull();
    unmount(cmp);
  });
});

test("a zoom gesture doesn't survive a reload to a shorter document", async () => {
  const props = $state({ source: { path: "/p/a.pdf", size: 1000, modified: 1 } });
  const target = document.createElement("div");
  document.body.append(target);
  const cmp = mount(PdfView, { target, props });
  flushSync();
  await settle();
  const scroller = target.querySelector<HTMLElement>(".scroller")!;
  let top = 0;
  const written: number[] = [];
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { written.push(v); top = v; } });
  await scrollTo(scroller, topOf(2000));
  const wheel = () => scroller.dispatchEvent(Object.assign(new Event("wheel", { bubbles: true, cancelable: true }), { deltaY: -40, deltaMode: 0, clientX: 40, clientY: 100, ctrlKey: true }));
  wheel();
  await new Promise((r) => setTimeout(r, 30));
  await settle();
  const atGesture = top;
  pdf.pages = 3;
  props.source = { path: "/p/a.pdf", size: 1000, modified: 2 };
  flushSync();
  await settle();
  top = atGesture; // what the gesture remembers
  written.length = 0;
  wheel();
  await new Promise((r) => setTimeout(r, 30));
  await settle();
  expect(written.length).toBeGreaterThan(0);
  expect(written.every(Number.isFinite)).toBe(true);
  pdf.pages = 3000;
  unmount(cmp);
});

describe("ctrl + wheel", () => {
  const wheel = (el: HTMLElement, deltaY: number, x = 40, y = 100, ctrlKey = true) => {
    const e = Object.assign(new Event("wheel", { bubbles: true, cancelable: true }), { deltaY, deltaMode: 0, clientX: x, clientY: y, ctrlKey }); // the test DOM's WheelEvent drops ctrlKey
    el.dispatchEvent(e);
    return e;
  };
  const wait = async (ms = 30) => {
    await new Promise((r) => setTimeout(r, ms));
    await settle();
  };

  test("zooms like the buttons, and nothing else reacts to the event", async () => {
    const outer = vi.fn();
    document.body.addEventListener("wheel", outer);
    const { target, scroller, cmp } = await view();
    const e = wheel(scroller, -100);
    expect(e.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    await wait();
    expect(target.querySelector(".pct")!.textContent).toMatch(/12\d %/);
    expect(wheel(scroller, -100, 40, 100, false).defaultPrevented).toBe(false); // plain wheel scrolls
    document.body.removeEventListener("wheel", outer);
    unmount(cmp);
  });

  test("the point under the cursor stays there", async () => {
    const { scroller, cmp } = await view();
    await scrollTo(scroller, topOf(40) + 50);
    const y = 100;
    const before = scroller.scrollTop + y;
    const onPage = (before - topOf(40)) / 200;
    wheel(scroller, -200, 40, y);
    await wait();
    const scale = Math.exp(200 * 0.00223);
    const top = 16 + 39 * (200 * scale + 14);
    expect(scroller.scrollTop + y).toBeCloseTo(top + onPage * 200 * scale, 0);
    unmount(cmp);
  });

  test("over many steps the point doesn't creep, although the browser rounds scroll positions", async () => {
    const { scroller, cmp } = await view();
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = Math.floor(v)) });
    await scrollTo(scroller, topOf(40) + 50);
    const y = 100;
    const onPage = (scroller.scrollTop + y - topOf(40)) / 200;
    let total = 0;
    for (let i = 0; i < 30; i++) {
      wheel(scroller, -10, 40, y);
      total += 10;
      await wait(20);
    }
    const scale = Math.exp(total * 0.00223);
    const pageTop = 16 + 39 * (200 * scale + 14);
    expect(Math.abs(scroller.scrollTop + y - (pageTop + onPage * 200 * scale))).toBeLessThan(1.5);
    unmount(cmp);
  });

  test("small pinch deltas add up, many events cause one layout and no render per event", async () => {
    const { target, scroller, cmp } = await view();
    await wait();
    pdf.rendered = [];
    for (let i = 0; i < 100; i++) wheel(scroller, -1);
    expect(pdf.rendered).toEqual([]);
    await wait();
    expect(target.querySelector(".pct")!.textContent).toMatch(/12\d %/);
    expect(pdf.rendered).toEqual([]); // the sharp render waits until the zoom has settled
    await wait(160);
    expect(pdf.rendered.length).toBeGreaterThan(0);
    expect(pdf.rendered.length).toBeLessThan(8);
    unmount(cmp);
  });

  test("stops at the limits of the buttons", async () => {
    const { target, scroller, cmp } = await view();
    for (let i = 0; i < 40; i++) wheel(scroller, -300);
    await wait();
    expect(target.querySelector(".pct")!.textContent).toContain("400 %");
    for (let i = 0; i < 80; i++) wheel(scroller, 300);
    await wait();
    expect(target.querySelector(".pct")!.textContent).toContain("5 %");
    unmount(cmp);
  });

  test("the old bitmap stays while zooming", async () => {
    const { target, scroller, cmp } = await view();
    await wait();
    const old = target.querySelector('[data-page="1"] canvas');
    pdf.manual = true;
    wheel(scroller, -100);
    await wait();
    expect(target.querySelector('[data-page="1"] canvas')).toBe(old);
    unmount(cmp);
  });
});
