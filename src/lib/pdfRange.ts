/** Feeds pdf.js from the file on demand, so opening a PDF doesn't copy it through IPC. */
import * as pdfjs from "pdfjs-dist";
import { fsApi } from "./api";

/** Largest single read; `MAX_RANGE_READ` in fs.rs enforces it. */
export const RANGE_PIECE = 4 * 1024 * 1024;
export const RANGE_CHUNK = 16 * 1024;

export class FileRangeTransport extends pdfjs.PDFDataRangeTransport {
  private closed = false;

  constructor(
    private readonly path: string,
    length: number,
    private readonly onFail: (error: unknown) => void,
  ) {
    super(length, null as unknown as Uint8Array);
  }

  override requestDataRange(begin: number, end: number) {
    void this.load(begin, end);
  }

  private async load(begin: number, end: number) {
    try {
      // pdf.js wants one answer per request, so larger ranges are read in pieces and joined.
      const out = new Uint8Array(end - begin);
      for (let at = begin; at < end; at += RANGE_PIECE) {
        const piece = await fsApi.readFileRange(this.path, at, Math.min(RANGE_PIECE, end - at));
        if (this.closed) return;
        if (piece.length !== Math.min(RANGE_PIECE, end - at)) throw new Error("short read");
        out.set(piece, at - begin);
      }
      this.onDataRange(begin, out);
    } catch (e) {
      if (!this.closed) this.onFail(e);
    }
  }

  close() {
    this.closed = true;
  }
}
