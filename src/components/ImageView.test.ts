import { expect, test, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.mock("../lib/i18n/index.svelte", () => ({ t: (k: string) => k }));
vi.mock("../lib/viewerData", () => ({ imageSource: async () => "data:image/png;base64,AAAA" }));

import ImageView from "./ImageView.svelte";

/** The test DOM's WheelEvent drops the modifier keys. */
const wheelEvent = (o: { deltaY: number; deltaMode?: number; clientX?: number; clientY?: number; ctrlKey?: boolean }) =>
  Object.assign(new Event("wheel", { bubbles: true, cancelable: true }), { deltaMode: 0, clientX: 0, clientY: 0, ctrlKey: true, ...o });

const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

test("ctrl + wheel zooms the image, keeping the point under the cursor", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const cmp = mount(ImageView, { target, props: { data: { url: "x", size: 3 }, path: "/p/a.png", onText: null } });
  await settle();
  const img = target.querySelector("img")!;
  Object.defineProperty(img, "naturalWidth", { value: 400 });
  Object.defineProperty(img, "naturalHeight", { value: 200 });
  img.dispatchEvent(new Event("load"));
  await settle();
  const scroller = target.querySelector<HTMLElement>(".scroller")!;
  // The image lies at 16,16 minus the scroll offset, at its current style size.
  img.getBoundingClientRect = () => {
    const w = parseFloat(img.style.width), h = parseFloat(img.style.height);
    return { left: 16 - scroller.scrollLeft, top: 16 - scroller.scrollTop, width: w, height: h } as DOMRect;
  };
  scroller.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
  const before = parseFloat(img.style.width);
  const fx = (116 - 16) / before;
  const e = wheelEvent({ deltaY: -200, clientX: 116, clientY: 66 });
  scroller.dispatchEvent(e);
  expect(e.defaultPrevented).toBe(true);
  await new Promise((r) => setTimeout(r, 30));
  await settle();
  const after = parseFloat(img.style.width);
  expect(after).toBeGreaterThan(before * 1.4);
  expect(16 - scroller.scrollLeft + fx * after).toBeCloseTo(116, 0);
  unmount(cmp);
});
