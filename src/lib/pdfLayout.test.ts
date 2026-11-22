import { describe, expect, test } from "vitest";
import { MAX_SCROLL_HEIGHT, PAGE_GAP, PAGE_PADDING, PdfLayout, evictions, renderOrder } from "./pdfLayout";

const fixed = (s: number) => () => s;

describe("PdfLayout", () => {
  test("offsets come from the sizes", () => {
    const l = new PdfLayout(3, 100, 200, fixed(2));
    expect([...l.tops]).toEqual([PAGE_PADDING, PAGE_PADDING + 400 + PAGE_GAP, PAGE_PADDING + 2 * (400 + PAGE_GAP)]);
    expect(l.total).toBe(2 * PAGE_PADDING + 3 * 400 + 2 * PAGE_GAP);
  });

  test("laying out a million pages needs no DOM and little time", () => {
    const a = performance.now();
    const l = new PdfLayout(1_000_000, 600, 800, fixed(1));
    l.relayout(fixed(1.5));
    expect(l.pageAt(l.tops[777_777] + 1)).toBe(777_777);
    expect(performance.now() - a).toBeLessThan(1000);
  });

  test("a real page size moves only what follows", () => {
    const l = new PdfLayout(4, 100, 100, fixed(1));
    const before = l.tops[1];
    expect(l.setSize(2, 100, 300)).toBe(true);
    expect(l.tops[1]).toBe(before);
    expect(l.tops[3] - l.tops[2]).toBe(300 + PAGE_GAP);
    expect(l.setSize(2, 100, 300)).toBe(false);
  });

  test("fit width gives each page its own scale", () => {
    const l = new PdfLayout(2, 100, 100, (w) => 1000 / w);
    l.setSize(1, 500, 100);
    expect(l.pageWidth(0)).toBeCloseTo(1000);
    expect(l.pageWidth(1)).toBeCloseTo(1000);
  });

  test("the range holds the view and its margin", () => {
    const l = new PdfLayout(100, 100, 100, fixed(1));
    const y = l.tops[50];
    expect(l.range(y, 50, 0)).toEqual([50, 50]);
    expect(l.range(y, 50, 120)).toEqual([49, 51]);
    expect(l.range(1e9, 50, 0)).toEqual([99, 99]);
  });

  test("a position survives a zoom", () => {
    const l = new PdfLayout(10, 100, 100, fixed(1));
    const a = l.anchor(l.tops[7] + 25);
    l.relayout(fixed(3));
    expect(l.resolve(a)).toBeCloseTo(l.tops[7] + 75);
  });

  test("a document beyond the browser's limit scrolls through a compressed range", () => {
    const l = new PdfLayout(100_000, 600, 800, fixed(1));
    expect(l.compress).toBeLessThan(1);
    expect(l.scrollHeight).toBeCloseTo(MAX_SCROLL_HEIGHT);
    expect(new PdfLayout(10, 600, 800, fixed(1)).compress).toBe(1);
  });

  test("the largest scroll position of a compressed document is exactly its end", () => {
    const l = new PdfLayout(100_000, 600, 800, fixed(1));
    const view = 700;
    expect((l.spacerHeight(view) - view) / l.compress).toBeCloseTo(l.total - view, 3);
    const short = new PdfLayout(10, 600, 800, fixed(1));
    expect(short.spacerHeight(view)).toBe(short.total);
  });
});

test("the page in the middle of the view renders first", () => {
  expect(renderOrder(3, 7, 5)).toEqual([5, 6, 4, 7, 3]);
  expect(renderOrder(3, 5, 3)).toEqual([3, 4, 5]);
  expect(renderOrder(3, 5, 99)).toEqual([5, 4, 3]);
});

test("the bitmap budget drops the farthest pages and never a visible one", () => {
  const items = [0, 5, 6, 20].map((index) => ({ index, pixels: 10, keep: index === 5 || index === 6 }));
  expect(evictions(items, 5, 40)).toEqual([]);
  expect(evictions(items, 5, 30)).toEqual([20]);
  expect(evictions(items, 5, 5)).toEqual([20, 0]);
  expect(evictions(items, 5, 1000, 1)).toEqual([20]); // also a limit on how many pages stay
});
