import { describe, expect, test } from "vitest";
import { applyScroll } from "./snapshot";

function scrolled(top: number, left = 0) {
  const scroller = document.createElement("div");
  scroller.innerHTML = `<div class="gutters" style="position: sticky"></div><span class="tip"></span><div class="content" style="transform: scale(2)"></div>`;
  document.body.append(scroller);
  Object.defineProperty(scroller, "scrollTop", { value: top });
  Object.defineProperty(scroller, "scrollLeft", { value: left });
  return scroller;
}

describe("applyScroll (#137)", () => {
  test("children of a scrolled element are shifted in the clone, filtered nodes skipped", () => {
    const root = document.createElement("main");
    const scroller = scrolled(120, 30);
    root.append(scroller);
    document.body.append(root);
    const filter = (n: Node) => !(n instanceof HTMLElement && n.classList.contains("tip"));
    // What html-to-image builds: filtered children only, plus a trailing pseudo-element <style>.
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelector(".tip")!.remove();
    clone.firstElementChild!.append(document.createElement("style"));
    applyScroll(root, clone, filter);
    const [gutters, content, style] = [...clone.firstElementChild!.children] as HTMLElement[];
    expect(gutters.style.transform).toBe("translate(0px, -120px)"); // sticky: no horizontal shift
    expect(content.style.transform).toBe("translate(-30px, -120px) scale(2)");
    expect(style.style.transform).toBe("");
    expect(clone.firstElementChild!.getAttribute("style")).toBeNull(); // the scroller itself stays
  });

  test("nothing changes without scrolling", () => {
    const root = scrolled(0);
    const clone = root.cloneNode(true) as HTMLElement;
    applyScroll(root, clone);
    expect(clone.querySelector<HTMLElement>(".gutters")!.style.transform).toBe("");
  });
});
