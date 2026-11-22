import katex from "katex";
import { describe, expect, test, vi } from "vitest";
import { ImageWidget, MathWidget, renderMath } from "./widgets";

const img = (src: string) => new ImageWidget(src, "alt").toDOM() as HTMLImageElement;

describe("ImageWidget", () => {
  // #89: WebKitGTK rejects a plain (no-cors) <img> load from the asset protocol; a CORS load works.
  test("local files load in CORS mode", () => {
    expect(img("asset://localhost/%2Fhome%2Fme%2Fa.png").crossOrigin).toBe("anonymous");
    expect(img("http://asset.localhost/C%3A%2Fa.png").crossOrigin).toBe("anonymous");
  });

  test("web and data images keep a plain load", () => {
    expect(img("https://example.com/a.png").crossOrigin).toBeNull();
    expect(img("data:image/png;base64,AAAA").crossOrigin).toBeNull();
  });
});

describe("renderMath", () => {
  // #184: an error KaTeX throws is text and must never become markup.
  test("escapes markup in a thrown error", () => {
    const spy = vi.spyOn(katex, "renderToString").mockImplementation(() => {
      throw new Error(`<img src=x onerror="alert('1')">&`);
    });
    try {
      const html = renderMath("\\thrown184", false);
      expect(html).not.toContain("<img");
      const el = new MathWidget("\\thrown184", false).toDOM();
      expect(el.querySelector("img")).toBeNull();
      expect(el.querySelector(".md-math-error")?.textContent).toBe(`Error: <img src=x onerror="alert('1')">&`);
    } finally {
      spy.mockRestore();
    }
  });
});
