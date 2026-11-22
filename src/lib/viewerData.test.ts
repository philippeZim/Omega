import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ fileInfo: vi.fn(), readFileView: vi.fn() }));
vi.mock("./api", () => ({ fsApi: api }));
vi.mock("./i18n/index.svelte", () => ({ t: (k: string) => k }));

import { imageSource, loadViewerData, viewerHooks } from "./viewerData";
import { MAX_PDF_BYTES, MAX_VIEW_BYTES } from "./viewer";

beforeEach(() => {
  api.fileInfo.mockReset();
  api.readFileView.mockReset();
  viewerHooks.remoteImage = async () => null;
});

test("reads a local file", async () => {
  api.fileInfo.mockResolvedValue({ size: 3 });
  api.readFileView.mockResolvedValue(new Uint8Array([1, 2, 3]));
  expect((await loadViewerData("/p/a.png", "image")).size).toBe(3);
});

test("a too large image is refused before its bytes are read", async () => {
  api.fileInfo.mockResolvedValue({ size: MAX_VIEW_BYTES + 1 });
  await expect(loadViewerData("/p/a.png", "image")).rejects.toBe("app.viewer.tooLarge");
  expect(api.readFileView).not.toHaveBeenCalled();
});

test("a PDF isn't read at all when opening, also above the image limit", async () => {
  api.fileInfo.mockResolvedValue({ size: MAX_VIEW_BYTES * 8 });
  const d = await loadViewerData("/p/a.pdf", "pdf");
  expect(d.file).toEqual({ path: "/p/a.pdf", size: MAX_VIEW_BYTES * 8 });
  expect(api.readFileView).not.toHaveBeenCalled();
});

test("an empty or absurdly large PDF gets a message", async () => {
  api.fileInfo.mockResolvedValue({ size: 0 });
  await expect(loadViewerData("/p/a.pdf", "pdf")).rejects.toBe("app.viewer.brokenPdf");
  api.fileInfo.mockResolvedValue({ size: MAX_PDF_BYTES + 1 });
  await expect(loadViewerData("/p/a.pdf", "pdf")).rejects.toBe("app.viewer.tooLarge");
});

test("a guest never reads a shared file from the local disk", async () => {
  viewerHooks.remoteImage = vi.fn(async () => "data:image/png;base64,AAAA");
  const d = await loadViewerData("collab:img/a.png", "image");
  expect(viewerHooks.remoteImage).toHaveBeenCalledWith("img/a.png");
  expect(d).toEqual({ url: "data:image/png;base64,AAAA", size: 3 });
  expect(api.fileInfo).not.toHaveBeenCalled();
  expect(api.readFileView).not.toHaveBeenCalled();
});

test("a guest gets a clear message when the host refuses, and for PDFs", async () => {
  await expect(loadViewerData("collab:../secret.png", "image")).rejects.toBe("app.viewer.guestImage");
  await expect(loadViewerData("collab:a.pdf", "pdf")).rejects.toBe("app.viewer.guestPdf");
  expect(api.readFileView).not.toHaveBeenCalled();
});

test("an image becomes a data URL of its type, so an SVG can only render through <img>", async () => {
  const url = await imageSource({ bytes: new TextEncoder().encode("<svg/>"), size: 6 }, "/p/A.SVG");
  expect(url).toBe(`data:image/svg+xml;base64,${btoa("<svg/>")}`);
});
