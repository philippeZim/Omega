/** pdf.js page helpers shared by the LaTeX PDF panel and the PDF viewer tab. */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PageLink {
  url?: string;
  dest?: string | unknown[];
}

/** The empty, correctly sized element of one page. */
export function createPageShell(index: number, vp: { width: number; height: number }): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "page";
  wrap.dataset.page = String(index);
  wrap.style.width = `${vp.width}px`;
  wrap.style.height = `${vp.height}px`;
  return wrap;
}

/** Draws the page on a new canvas inside `wrap`. The returned task can be cancelled. */
export function paintPage(page: pdfjs.PDFPageProxy, wrap: HTMLElement, vp: pdfjs.PageViewport, dpr: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  wrap.appendChild(canvas);
  return page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
}

/**
 * The canvas is only a picture: overlays the PDF's link annotations (hyperref: table of contents,
 * \ref, \cite, \url) as clickable boxes.
 */
export async function addPageLinks(page: pdfjs.PDFPageProxy, vp: pdfjs.PageViewport, wrap: HTMLElement, open: (link: PageLink) => void) {
  const annots = await page.getAnnotations({ intent: "display" }).catch(() => []);
  for (const a of annots) {
    if (a.subtype !== "Link" || (!a.dest && !a.url)) continue;
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
    const el = document.createElement("a");
    el.className = "link";
    el.style.left = `${Math.min(x1, x2)}px`;
    el.style.top = `${Math.min(y1, y2)}px`;
    el.style.width = `${Math.abs(x2 - x1)}px`;
    el.style.height = `${Math.abs(y2 - y1)}px`;
    if (a.url) el.title = a.url;
    el.onclick = (e) => {
      e.preventDefault();
      open({ url: a.url, dest: a.dest });
    };
    el.ondblclick = (e) => e.stopPropagation(); // don't trigger reverse sync
    wrap.appendChild(el);
  }
}

/** A PDF destination (named, or explicit `[pageRef, {name}, …args]`) as page index and PDF y. */
export async function resolvePdfDest(doc: pdfjs.PDFDocumentProxy, dest: string | unknown[]): Promise<{ index: number; y: number | null } | null> {
  const explicit = typeof dest === "string" ? await doc.getDestination(dest).catch(() => null) : dest;
  if (!explicit?.length) return null;
  const ref = explicit[0] as number | { num: number; gen: number };
  const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref).catch(() => -1);
  if (index < 0) return null;
  // PDF y runs bottom-up; XYZ carries (left, top, zoom), FitH/FitBH carry (top).
  const kind = (explicit[1] as { name?: string } | undefined)?.name;
  const y = kind === "XYZ" ? explicit[3] : kind === "FitH" || kind === "FitBH" ? explicit[2] : null;
  return { index, y: typeof y === "number" ? y : null };
}
