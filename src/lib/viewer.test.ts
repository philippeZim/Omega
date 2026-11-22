import { describe, expect, test } from "vitest";
import { MAX_ZOOM, MIN_ZOOM, fitScale, imageMime, safePdfUrl, stepZoom, viewerKind } from "./viewer";

describe("viewerKind", () => {
  test.each(["a.png", "a.jpg", "a.JPEG", "b/c.GiF", "a.webp", "a.bmp", "a.ico", "a.avif", "a.Svg"])("%s is an image", (p) => expect(viewerKind(p)).toBe("image"));
  test.each(["a.pdf", "/x/A.PDF"])("%s is a PDF", (p) => expect(viewerKind(p)).toBe("pdf"));
  test.each(["a.txt", "png", ".png", "a.png.txt", "dir.png/file", "a.constructor", null, undefined])("%s has no viewer", (p) => expect(viewerKind(p)).toBeNull());
});

test("the MIME type follows the extension", () => {
  expect(imageMime("a.JPG")).toBe("image/jpeg");
  expect(imageMime("a.svg")).toBe("image/svg+xml");
});

test("fit shrinks large images and never enlarges small ones", () => {
  expect(fitScale(2000, 1000, 1000, 1000)).toBe(0.5);
  expect(fitScale(10, 10, 1000, 1000)).toBe(1);
  expect(fitScale(0, 10, 100, 100)).toBe(1);
});

test("zoom steps stay within the limits", () => {
  expect(stepZoom(1, 1)).toBe(1.25);
  expect(stepZoom(1.25, -1)).toBe(1);
  expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
});

test("PDF links only open web and mail addresses", () => {
  expect(safePdfUrl("https://example.com/a")).toBe("https://example.com/a");
  expect(safePdfUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/x", "nonsense", undefined]) expect(safePdfUrl(bad)).toBeNull();
});
