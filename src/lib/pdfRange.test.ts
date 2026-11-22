import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readFileRange: vi.fn() }));
vi.mock("./api", () => ({ fsApi: api }));
vi.mock("pdfjs-dist", () => ({
  PDFDataRangeTransport: class {
    constructor(public length: number) {}
    onDataRange = vi.fn();
  },
}));

import { FileRangeTransport, RANGE_PIECE } from "./pdfRange";

const settle = () => new Promise((r) => setTimeout(r, 0));
beforeEach(() => api.readFileRange.mockReset());

test("a range is read in bounded pieces and answered once, whole", async () => {
  api.readFileRange.mockImplementation(async (_p: string, at: number, len: number) => new Uint8Array(len).fill(at === 0 ? 1 : 2));
  const t = new FileRangeTransport("/p/a.pdf", 1e9, vi.fn());
  t.requestDataRange(0, RANGE_PIECE + 10);
  await settle();
  expect(api.readFileRange.mock.calls).toEqual([["/p/a.pdf", 0, RANGE_PIECE], ["/p/a.pdf", RANGE_PIECE, 10]]);
  const [begin, chunk] = vi.mocked(t.onDataRange).mock.calls[0];
  expect(begin).toBe(0);
  expect((chunk as Uint8Array).length).toBe(RANGE_PIECE + 10);
  expect((chunk as Uint8Array)[RANGE_PIECE]).toBe(2);
});

test("a file that shrank or can't be read fails instead of hanging", async () => {
  const fail = vi.fn();
  api.readFileRange.mockResolvedValueOnce(new Uint8Array(3));
  new FileRangeTransport("/p/a.pdf", 100, fail).requestDataRange(0, 10);
  await settle();
  expect(fail).toHaveBeenCalledTimes(1);
  api.readFileRange.mockRejectedValueOnce("denied");
  new FileRangeTransport("/p/a.pdf", 100, fail).requestDataRange(0, 10);
  await settle();
  expect(fail).toHaveBeenLastCalledWith("denied");
});

test("after close an answer is dropped", async () => {
  let resolve = (_b: Uint8Array) => {};
  api.readFileRange.mockReturnValue(new Promise((r) => (resolve = r)));
  const fail = vi.fn();
  const t = new FileRangeTransport("/p/a.pdf", 100, fail);
  t.requestDataRange(0, 2);
  t.close();
  resolve(new Uint8Array(2));
  await settle();
  expect(t.onDataRange).not.toHaveBeenCalled();
  expect(fail).not.toHaveBeenCalled();
});
