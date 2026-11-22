import { beforeEach, expect, test, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.mock("../lib/native", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/i18n/index.svelte", () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${p.page}/${p.total}` : k) }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

/** Fake pdf.js: 3000 pages of 100x200, except page 2500 (100x400), whose link target is page 2500. */
const pdf = vi.hoisted(() => {
  const s = {
    pages: 3000,
    requested: [] as number[],
    cleaned: [] as number[],
    hold: null as Promise<void> | null,
    annots: {} as Record<number, unknown[]>,
    page(n: number) {
      const h = n === 2500 ? 400 : 200;
      return {
        getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: h * scale, scale, convertToViewportRectangle: () => [0, 0, 10, 10] }),
        render: () => ({ promise: Promise.resolve(), cancel() {} }),
        getAnnotations: async () => s.annots[n] ?? [],
        cleanup: () => void s.cleaned.push(n),
      };
    },
    doc() {
      return {
        numPages: s.pages,
        getPage: async (n: number) => {
          s.requested.push(n);
          if (n > 1 && s.hold) await s.hold;
          return s.page(n);
        },
        getPageIndex: async (ref: { num: number }) => ref.num,
        getDestination: async () => null,
        destroy: async () => {},
      };
    },
  };
  return s;
});
const getDocument = vi.hoisted(() => vi.fn());
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument }));

import PdfView from "./PdfView.svelte";

async function settle() {
  for (let i = 0; i < 40; i++) await tick();
}

async function view() {
  const target = document.createElement("div");
  document.body.append(target);
  const cmp = mount(PdfView, { target, props: { bytes: new Uint8Array([1]) } });
  flushSync();
  await settle();
  const scroller = target.querySelector<HTMLElement>(".scroller")!;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  scroller.scrollTo = ((o: ScrollToOptions) => void (scroller.scrollTop = o.top ?? 0)) as typeof scroller.scrollTo;
  return { target, scroller, cmp };
}

// jsdom has no layout: every page takes 60px plus the 14px gap.
Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get(this: HTMLElement) { return ((Number(this.dataset.page) || 1) - 1) * 74; } });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return parseFloat(this.style.height) || 0; } });

beforeEach(() => {
  getDocument.mockReset();
  getDocument.mockImplementation(() => ({ promise: Promise.resolve(pdf.doc()) }));
  pdf.requested = [];
  pdf.cleaned = [];
  pdf.hold = null;
  pdf.annots = {};
  document.body.replaceChildren();
});

test("a huge PDF shows its count and all shells after loading only the first pages", async () => {
  let release = () => {};
  pdf.hold = new Promise((r) => (release = r));
  const { target, cmp } = await view();
  expect(target.querySelector(".info")!.textContent).toContain("/3000");
  expect(target.querySelectorAll(".page")).toHaveLength(3000);
  expect(pdf.requested.length).toBeLessThan(40);
  release();
  await settle();
  unmount(cmp);
});

test("scrolling away lets go of pages and fetches the ones now near", async () => {
  const { scroller, cmp } = await view();
  const before = pdf.requested.length;
  scroller.scrollTop = 60 * (200 * 0.3 + 14) * 10;
  scroller.dispatchEvent(new Event("scroll"));
  await settle();
  expect(pdf.requested.length).toBeGreaterThan(before);
  expect(pdf.requested).not.toContain(1500);
  expect(pdf.cleaned).toContain(1);
  unmount(cmp);
});

test("a link to a page not loaded yet lands on it, and its real size corrects the shell", async () => {
  // Page index 2499 is page 2500, twice as high as page 1.
  pdf.annots[1] = [{ subtype: "Link", dest: [2499, { name: "XYZ" }, 0, 400, 0], rect: [0, 0, 1, 1] }];
  const { target, scroller, cmp } = await view();
  await settle();
  expect(pdf.requested).not.toContain(2500);
  target.querySelector<HTMLElement>(".page a.link")!.click();
  await settle();
  expect(pdf.requested).toContain(2500);
  const shell = target.querySelector<HTMLElement>('[data-page="2500"]')!;
  expect(parseFloat(shell.style.height)).toBeCloseTo(400 * 0.3);
  expect(scroller.scrollTop).toBe(2499 * 74 - 12);
  expect(target.querySelector(".info")!.textContent).toMatch(/250[01]\/3000/); // the page a third down the view
  unmount(cmp);
});

test("pdf.js doesn't decode images through OffscreenCanvas, which mixes up pages in WebKitGTK", async () => {
  const { cmp } = await view();
  expect(getDocument.mock.calls[0][0]).toMatchObject({ isOffscreenCanvasSupported: false, isEvalSupported: false });
  unmount(cmp);
});

test("laying out thousands of pages reads the width once, not once per page (a forced reflow each)", async () => {
  let reads = 0;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("scroller")) reads++;
      return 800;
    },
  });
  try {
    const { cmp } = await view();
    expect(reads).toBeLessThan(20);
    unmount(cmp);
  } finally {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  }
});
