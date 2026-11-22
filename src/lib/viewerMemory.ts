/** Where each PDF tab was, so a tab switch returns there. Small values only, never a document or bitmap. */
import type { PdfAnchor } from "./pdfPager";

export interface ViewerPlace {
  zoom: number;
  anchor: PdfAnchor;
}

const places = new Map<string, ViewerPlace>();

export const viewerPlace = (tabId: string) => places.get(tabId);
export const rememberViewer = (tabId: string, place: ViewerPlace) => void places.set(tabId, place);
export const forgetViewer = (tabId: string) => void places.delete(tabId);
