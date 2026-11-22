/** Loads what a viewer tab shows: from disk, or for a guest through the host's checked image route. */
import { fsApi } from "./api";
import { t } from "./i18n/index.svelte";
import { formatSize } from "./largeFile";
import { imageMime, MAX_PDF_BYTES, MAX_VIEW_BYTES, type ViewerKind } from "./viewer";

/** A PDF on disk as it was when opened: reads fail once it no longer has this size and time. */
export type PdfFile = { path: string; size: number; modified: number };

/** A PDF isn't loaded here: pdf.js reads the parts it needs from `file`. */
export type ViewerData =
  | { bytes: Uint8Array; size: number; url?: undefined; file?: undefined }
  | { url: string; size: number; bytes?: undefined; file?: undefined }
  | { file: PdfFile; size: number; bytes?: undefined; url?: undefined };

/** Set by collab/assets.svelte.ts (avoids an import cycle). */
export const viewerHooks = {
  remoteImage: async (_rel: string): Promise<string | null> => null,
};

/** Rejects with a translated message. */
export async function loadViewerData(path: string, kind: ViewerKind): Promise<ViewerData> {
  if (path.startsWith("collab:")) {
    if (kind === "pdf") throw t("app.viewer.guestPdf");
    const url = await viewerHooks.remoteImage(path.slice("collab:".length));
    if (!url) throw t("app.viewer.guestImage");
    // Base64 carries 3 bytes in 4 characters.
    return { url, size: Math.floor(((url.length - url.indexOf(",") - 1) * 3) / 4) };
  }
  const info = await fsApi.fileInfo(path);
  if (kind === "pdf") {
    if (info.size > MAX_PDF_BYTES) throw t("app.viewer.tooLarge", { size: formatSize(info.size), max: formatSize(MAX_PDF_BYTES) });
    if (info.size === 0) throw t("app.viewer.brokenPdf");
    return { file: { path, size: info.size, modified: info.modified }, size: info.size };
  }
  if (info.size > MAX_VIEW_BYTES) throw t("app.viewer.tooLarge", { size: formatSize(info.size), max: formatSize(MAX_VIEW_BYTES) });
  const bytes = await fsApi.readFileView(path);
  return { bytes, size: bytes.length };
}

/**
 * A `data:` URL for `<img>`, where scripts in an SVG don't run. Not a blob URL: the window snapshot
 * (control MCP screenshots) can't load those, and one open image would make it fail altogether.
 */
export function imageSource(data: ViewerData, path: string): Promise<string> {
  if (data.url) return Promise.resolve(data.url);
  if (!data.bytes) return Promise.reject(new Error("no image data"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([data.bytes as BlobPart], { type: imageMime(path) }));
  });
}
