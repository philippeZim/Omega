import { expect, test, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, PDFWorker: class {} }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

import { MAX_CANVAS_PIXELS, PDF_LOAD_OPTIONS, canvasRatio, pdfWorker } from "./pdfPages";

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
