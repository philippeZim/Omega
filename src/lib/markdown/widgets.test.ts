import { describe, expect, test } from "vitest";
import { ImageWidget } from "./widgets";

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
