// DOM helpers of the control MCP. happy-dom has no layout: elements get their box from
// `data-rect="x,y,w,h"` and their stacking from `data-z`; elementFromPoint picks the topmost box.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { findElements, keyCode, labelOf, reachable, typesIntoEditor } from "./dom";
import { audit, modalLayer } from "./uiAudit";

function rectOf(el: Element) {
  const [x, y, w, h] = ((el as HTMLElement).dataset?.rect ?? "0,0,0,0").split(",").map(Number);
  return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON() {} } as DOMRect;
}
const z = (el: Element) => {
  for (let e: Element | null = el; e; e = e.parentElement) if ((e as HTMLElement).dataset?.z) return +(e as HTMLElement).dataset.z!;
  return 0;
};

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rectOf(this);
  });
  document.elementFromPoint = (x: number, y: number) => {
    const hits = [...document.querySelectorAll<HTMLElement>("[data-rect]")].filter((e) => {
      const r = rectOf(e);
      return r.width > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    });
    // Highest z wins, then the later (deeper / later in DOM order) element, like real stacking.
    hits.sort((a, b) => z(a) - z(b) || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return hits[hits.length - 1] ?? null;
  };
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// App layout: a button in the main window, the collab panel (role=dialog, not modal, z 90) and
// the generic Dialog (z 100) on a full-window backdrop that comes *before* the panel in the DOM.
const APP = `
  <button data-rect="10,10,80,30">Open Folder</button>
  <div class="backdrop" style="position:fixed" data-z="100" data-rect="0,0,1000,800">
    <div role="dialog" data-rect="300,300,400,200">
      <input placeholder="Your name" data-rect="320,320,200,30">
      <button data-rect="560,420,60,30">OK</button>
    </div>
  </div>
  <div role="dialog" class="collab" style="position:fixed" data-z="90" data-rect="700,50,280,400">
    <button data-rect="720,70,100,30">Start session</button>
  </div>
  <div class="toasts" style="position:fixed" data-z="120" data-rect="350,20,300,40"><button data-rect="360,25,80,30">Undo</button></div>`;

describe("reachable / findElements", () => {
  test("a modal opened from a non-modal panel later in the DOM can be clicked", () => {
    document.body.innerHTML = APP;
    expect(findElements({ text: "OK", exact: true })).toHaveLength(1);
    expect(findElements({ text: "Your name" })[0]?.tagName).toBe("INPUT");
  });
  test("controls under the backdrop are out of reach, toasts above it are not", () => {
    document.body.innerHTML = APP;
    expect(findElements({ text: "Open Folder" })).toHaveLength(0);
    expect(findElements({ text: "Start session" })).toHaveLength(0);
    expect(findElements({ text: "Undo" })).toHaveLength(1);
    expect(findElements({ text: "Open Folder", all: true })).toHaveLength(1); // screenshots, wait_for
  });
  test("a non-modal panel does not block the rest of the window", () => {
    document.body.innerHTML = APP;
    document.querySelector(".backdrop")!.remove();
    expect(findElements({ text: "Open Folder" })).toHaveLength(1);
    expect(findElements({ text: "Start session" })).toHaveLength(1);
  });
  test("context menu items above everything are reachable", () => {
    document.body.innerHTML = APP + `<div role="menu" style="position:fixed" data-z="200" data-rect="100,100,150,60"><button role="menuitem" data-rect="100,100,150,30">Rename</button></div>`;
    expect(findElements({ text: "Rename" })).toHaveLength(1);
  });
  test("elements outside the window count as reachable (clicking scrolls them in)", () => {
    document.body.innerHTML = `<button data-rect="10,2000,80,30">Far below</button>`;
    expect(reachable(document.querySelector("button")!)).toBe(true);
  });
});

describe("labels", () => {
  test("the live title wins over a stale data-tip copy", () => {
    document.body.innerHTML = `<button title="Paramètres" data-tip="Einstellungen" data-rect="0,0,30,30"></button>`;
    expect(labelOf(document.querySelector("button")!)).toBe("Paramètres");
    expect(findElements({ text: "Paramètres", exact: true })).toHaveLength(1);
  });
  test("text matches although a tooltip replaced the label", () => {
    document.body.innerHTML = `<button title="Ctrl Enter" data-rect="0,0,80,30">Commit</button>`;
    expect(findElements({ text: "Commit", exact: true })).toHaveLength(1);
  });
});

describe("keyCode", () => {
  test.each([
    ["a", "KeyA"], ["Z", "KeyZ"], ["1", "Digit1"], [",", "Comma"], [".", "Period"], ["/", "Slash"],
    ["^", "Backquote"], ["-", "Minus"], ["Enter", "Enter"], ["ArrowDown", "ArrowDown"],
  ])("%s → %s", (key, code) => expect(keyCode(key)).toBe(code));
});

describe("typesIntoEditor", () => {
  test("only the editor content, not inputs in its panels", () => {
    document.body.innerHTML = `<div class="cm-editor"><div class="cm-content" contenteditable="true"></div><div class="cm-panels"><input class="search"></div></div><input class="outside">`;
    const ed = document.querySelector(".cm-editor")!;
    expect(typesIntoEditor(document.querySelector(".cm-content"), ed)).toBe(true);
    expect(typesIntoEditor(document.querySelector(".search"), ed)).toBe(false);
    expect(typesIntoEditor(document.querySelector(".outside"), ed)).toBe(false);
    expect(typesIntoEditor(document.querySelector(".cm-content"), null)).toBe(false);
  });
});

describe("ui_audit", () => {
  test("inputs inside <label> or with label[for] are labelled; bare ones are not", () => {
    document.body.innerHTML = `
      <label data-rect="0,0,200,30">Size <input type="range" class="a" data-rect="50,0,100,30"></label>
      <label for="port" data-rect="0,40,50,30">Port</label><input id="port" class="b" data-rect="60,40,80,30">
      <input type="range" class="c" data-rect="0,80,100,30">`;
    const found = audit({ checks: ["unlabeled"] }).findings.map((f) => f.path);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("input.c");
  });
  test("the modal layer ignores non-modal panels with role=dialog", () => {
    document.body.innerHTML = APP;
    expect(modalLayer()?.classList.contains("backdrop")).toBe(true);
    document.querySelector(".backdrop")!.remove();
    expect(modalLayer()).toBeNull();
  });
});
