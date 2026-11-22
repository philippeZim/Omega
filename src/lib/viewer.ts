/** Pure rules of the image and PDF viewer tabs (#159). */
export type ViewerKind = "image" | "pdf";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** Largest file a viewer tab loads; `MAX_VIEW_FILE` in fs.rs enforces it. */
export const MAX_VIEW_BYTES = 64 * 1024 * 1024;
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
export const MAX_PDF_ZOOM = 4;

function extension(path: string) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Which viewer shows this file, by extension in any case; null for everything else. */
export function viewerKind(path: string | null | undefined): ViewerKind | null {
  if (!path) return null;
  const ext = extension(path);
  if (ext === "pdf") return "pdf";
  return ext in IMAGE_MIME && Object.hasOwn(IMAGE_MIME, ext) ? "image" : null;
}

export const imageMime = (path: string) => IMAGE_MIME[extension(path)] ?? "application/octet-stream";
export const isSvgPath = (path: string) => extension(path) === "svg";

/** Scale that fits the image into the box; small images keep their real size. */
export function fitScale(w: number, h: number, boxW: number, boxH: number) {
  if (w <= 0 || h <= 0 || boxW <= 0 || boxH <= 0) return 1;
  return Math.min(1, boxW / w, boxH / h);
}

/** The next zoom step from `current`, within the limits. */
export function stepZoom(current: number, dir: 1 | -1, max = MAX_ZOOM) {
  const next = dir > 0 ? current * 1.25 : current / 1.25;
  return Math.min(max, Math.max(MIN_ZOOM, Math.round(next * 1000) / 1000));
}

/** 1-based page shown at `y`, from the ascending top offsets of the pages. */
export function pageAt(tops: number[], y: number) {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return tops.length ? lo + 1 : 0;
}

/** 0-based first and last page within `margin` px of the visible range; null without pages. */
export function pagesNear(tops: number[], heights: number[], top: number, viewH: number, margin: number): [number, number] | null {
  if (!tops.length) return null;
  const from = top - margin;
  const to = top + viewH + margin;
  let first = pageAt(tops, from) - 1;
  if (tops[first] + heights[first] < from && first < tops.length - 1) first++;
  const last = pageAt(tops, to) - 1;
  return [first, Math.max(first, last)];
}

/** A PDF is untrusted: its links may only open web and mail addresses. */
export function safePdfUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}
