/**
 * Screenshot of a DOM element for the control MCP: html-to-image's toPng, plus scroll positions.
 *
 * html-to-image clones the DOM into an SVG <foreignObject>; a clone has no scroll offset, so a
 * scrolled container (CodeMirror's .cm-scroller above all) is drawn at position 0 – or blank, since
 * CodeMirror only renders the visible lines below a tall spacer. The same pipeline as `toPng`, with
 * one step added: after cloning, the children of every scrolled element are shifted by its offset.
 */
import { cloneNode } from "html-to-image/es/clone-node";
import { embedWebFonts } from "html-to-image/es/embed-webfonts";
import { embedImages } from "html-to-image/es/embed-images";
import { applyStyle } from "html-to-image/es/apply-style";
import { checkCanvasDimensions, createImage, getImageSize, getPixelRatio, nodeToDataURL } from "html-to-image/es/util";
import type { Options } from "html-to-image/es/types";

/** Elements html-to-image replaces or copies as a whole (no child walk to align). */
const opaque = (n: Element) => n instanceof HTMLCanvasElement || n instanceof HTMLVideoElement || n instanceof HTMLIFrameElement || n instanceof SVGElement;

/**
 * Re-applies the scroll offsets of `native`'s subtree to its clone. Clone children are the native
 * children that passed `filter`, in the same order (html-to-image only appends extra nodes – pseudo
 * element styles, SVG symbols – after them).
 */
export function applyScroll(native: Node, clone: Node, filter?: (n: Node) => boolean) {
  if (!(native instanceof Element) || !(clone instanceof Element) || opaque(native)) return;
  const kept = [...(native.shadowRoot ?? native).childNodes].filter((n) => !filter || filter(n));
  const cloned = [...clone.childNodes].slice(0, kept.length);
  const { scrollTop: top, scrollLeft: left } = native;
  if (top || left) {
    for (const [i, c] of cloned.entries()) {
      if (!(c instanceof HTMLElement || c instanceof SVGElement)) continue;
      // Sticky children (CodeMirror's gutters stick to the left) stay put along that axis.
      const sticky = getComputedStyle(kept[i] as Element).position === "sticky";
      const dx = sticky ? 0 : -left;
      const prev = c.style.transform && c.style.transform !== "none" ? " " + c.style.transform : "";
      c.style.transform = `translate(${dx}px, ${-top}px)${prev}`;
    }
  }
  kept.forEach((n, i) => cloned[i] && applyScroll(n, cloned[i], filter));
}

/** Like html-to-image's toPng, keeping scroll positions. */
export async function snapshotPng(node: HTMLElement, options: Options = {}): Promise<string> {
  const { width, height } = getImageSize(node, options);
  const clone = await cloneNode(node, options, true);
  if (!clone) throw new Error("nothing to draw");
  applyScroll(node, clone, options.filter as ((n: Node) => boolean) | undefined);
  await embedWebFonts(clone, options);
  // Remote images stay empty: the CSP (#166) lets fetch reach only the package hosts.
  await embedImages(clone, options);
  applyStyle(clone, options);
  const img = await createImage(await nodeToDataURL(clone, width, height));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const ratio = options.pixelRatio || getPixelRatio();
  canvas.width = (options.canvasWidth || width) * ratio;
  canvas.height = (options.canvasHeight || height) * ratio;
  if (!options.skipAutoScale) checkCanvasDimensions(canvas);
  if (options.backgroundColor) {
    ctx.fillStyle = options.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL();
}
