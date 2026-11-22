/** Feeds pdf.js from the file on demand, so opening a PDF doesn't copy it through IPC. */
import * as pdfjs from "pdfjs-dist";
import { fsApi } from "./api";
import type { PdfFile } from "./viewerData";

/** Largest single read; `MAX_RANGE_READ` in fs.rs enforces it. */
export const RANGE_PIECE = 4 * 1024 * 1024;
export const RANGE_CHUNK = 16 * 1024;

export class FileRangeTransport extends pdfjs.PDFDataRangeTransport {
  private closed = false;

  /** `onFail` runs once. `changed`: the file is no longer the version this document was opened from. */
  constructor(
    private readonly file: PdfFile,
    private readonly onFail: (changed: boolean) => void,
  ) {
    super(file.size, null as unknown as Uint8Array);
  }

  override requestDataRange(begin: number, end: number) {
    void this.load(begin, end);
  }

  private async load(begin: number, end: number) {
    const { path, size, modified } = this.file;
    try {
      // pdf.js wants one answer per request, so larger ranges are read in pieces and joined.
      const out = new Uint8Array(end - begin);
      for (let at = begin; at < end; at += RANGE_PIECE) {
        const piece = await fsApi.readFileRange(path, at, Math.min(RANGE_PIECE, end - at), size, modified);
        if (this.closed) return;
        if (piece.length !== Math.min(RANGE_PIECE, end - at)) throw "fs:changed";
        out.set(piece, at - begin);
      }
      this.onDataRange(begin, out);
    } catch (e) {
      if (this.closed) return;
      this.closed = true;
      this.onFail(String(e) === "fs:changed");
    }
  }

  close() {
    this.closed = true;
  }
}
