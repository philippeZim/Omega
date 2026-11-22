import { expect, test, vi } from "vitest";

const pdf = vi.hoisted(() => ({ getDocument: vi.fn(), workers: [] as { destroyed: boolean; destroy(): void }[] }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: pdf.getDocument,
  PDFWorker: class {
    destroyed = false;
    constructor() {
      pdf.workers.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

import { MAX_CANVAS_PIXELS, PDF_LOAD_OPTIONS, canvasRatio, loadPdf, pdfWorker } from "./pdfPages";

test("a normal page renders at full device resolution", () => {
  expect(canvasRatio(800, 1000, 2)).toBe(2);
});

test("a huge page is capped, so one canvas can't take the memory or the time", () => {
  const r = canvasRatio(3000, 4000, 3);
  expect(3000 * r * 4000 * r).toBeCloseTo(MAX_CANVAS_PIXELS, -2);
});

test("the worker is shared and the safe options stay on", () => {
  expect(pdfWorker()).toBe(pdfWorker());
  expect(PDF_LOAD_OPTIONS).toEqual({ isEvalSupported: false, isOffscreenCanvasSupported: false });
});

const named = (name: string) => Object.assign(new Error(name), { name });
const task = (promise: Promise<unknown>) => {
  void promise.catch(() => {});
  const t = { promise, destroyed: false, destroy: vi.fn(async () => void (t.destroyed = true)) };
  return t;
};

test("a load that fails on the worker gets a new worker and one more try", async () => {
  const dead = pdfWorker();
  const params = vi.fn(() => ({ url: "x" }));
  pdf.getDocument.mockReset();
  pdf.getDocument.mockReturnValueOnce(task(Promise.reject(named("UnknownErrorException")))).mockReturnValueOnce(task(Promise.resolve("doc")));
  await expect(loadPdf(params).promise).resolves.toBe("doc");
  expect(params).toHaveBeenCalledTimes(2);
  expect(pdf.getDocument.mock.calls[1][0].worker).not.toBe(dead);
  expect(pdfWorker()).toBe(pdf.getDocument.mock.calls[1][0].worker);
});

test.each(["PasswordException", "InvalidPDFException"])("%s keeps the worker and isn't retried", async (name) => {
  const w = pdfWorker();
  pdf.getDocument.mockReset();
  pdf.getDocument.mockReturnValueOnce(task(Promise.reject(named(name))));
  await expect(loadPdf(() => ({ url: "x" })).promise).rejects.toThrow(name);
  expect(pdf.getDocument).toHaveBeenCalledTimes(1);
  expect(pdfWorker()).toBe(w);
});

test("a replaced worker stays while a document is open on it, and ends after", async () => {
  vi.resetModules(); // a fresh shared worker, without the documents of other tests
  const { loadPdf, pdfWorker } = await import("./pdfPages");
  const old = pdfWorker() as unknown as { destroyed: boolean };
  pdf.getDocument.mockReset();
  const open = task(Promise.resolve("open doc"));
  pdf.getDocument.mockReturnValueOnce(open);
  await loadPdf(() => ({ url: "a" })).promise;
  pdf.getDocument.mockReturnValueOnce(task(Promise.reject(named("UnknownErrorException")))).mockReturnValueOnce(task(Promise.resolve("doc")));
  await loadPdf(() => ({ url: "b" })).promise;
  expect(old.destroyed).toBe(false);
  await open.destroy();
  pdf.getDocument.mockReturnValueOnce(task(Promise.resolve("doc")));
  await loadPdf(() => ({ url: "c" })).promise;
  pdf.getDocument.mockReturnValueOnce(task(Promise.reject(named("UnknownErrorException")))).mockReturnValueOnce(task(Promise.resolve("doc")));
  await loadPdf(() => ({ url: "d" })).promise;
  expect(old.destroyed).toBe(true);
});

test("a stopped load isn't retried", async () => {
  let reject = (_e: unknown) => {};
  pdf.getDocument.mockReset();
  pdf.getDocument.mockReturnValueOnce(task(new Promise((_, r) => (reject = r))));
  const load = loadPdf(() => ({ url: "x" }));
  await load.destroy();
  reject(named("UnknownErrorException"));
  await expect(load.promise).rejects.toThrow();
  expect(pdf.getDocument).toHaveBeenCalledTimes(1);
});
