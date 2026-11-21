/** Pure parts of guest Markdown assets and remote LaTeX: path rules, image cache, result mapping. */

/** What `ImageWidget` gets for a project image of a shared doc: the guest asks the host for it. */
export const ASSET_PREFIX = "collab-asset:";

/**
 * A link or image in the shared doc `from` ("collab:docs/a.md") as a project-relative path. Null for
 * anything that isn't one: URLs, absolute paths, paths leaving the project, unsaved tabs.
 */
export function remoteRel(href: string, from: string | null | undefined): string | null {
  if (!from?.startsWith("collab:") || from.startsWith("collab:tab:")) return null;
  let raw = href.split("#")[0].split("?")[0];
  try {
    raw = decodeURI(raw);
  } catch {
    // a literal "%" in the name
  }
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const parts = from.slice("collab:".length).split("/").slice(0, -1);
  for (const seg of raw.split("/")) {
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/") || null;
}

/** Image `data:` URLs by path, least recently used out first, bounded by total size. */
export class AssetCache {
  private items = new Map<string, string>();
  private total = 0;
  constructor(private readonly maxChars: number) {}

  get(key: string) {
    const v = this.items.get(key);
    if (v !== undefined) {
      this.items.delete(key);
      this.items.set(key, v);
    }
    return v;
  }

  set(key: string, url: string) {
    this.delete(key);
    if (url.length > this.maxChars) return;
    this.items.set(key, url);
    this.total += url.length;
    for (const k of this.items.keys()) {
      if (this.total <= this.maxChars) break;
      this.delete(k);
    }
  }

  delete(key: string) {
    const v = this.items.get(key);
    if (v === undefined) return;
    this.items.delete(key);
    this.total -= v.length;
  }

  clear() {
    this.items.clear();
    this.total = 0;
  }
}

/** Only raster types and SVG, and only ever as an `<img>` source. */
export const imageDataUrl = (mime: unknown, data: unknown) =>
  typeof mime === "string" && typeof data === "string" && /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(mime) && /^[A-Za-z0-9+/]*={0,2}$/.test(data) ? `data:${mime};base64,${data}` : null;

/** A project-relative file from the host as this guest's tab path; "" stays "" (no project file). */
export const guestFile = (rel: unknown) => (typeof rel === "string" && rel && !rel.startsWith("/") && !rel.split("/").includes("..") ? `collab:${rel}` : "");

/** Whether someone in the session can change the project but may not cause a compile. */
export const editorWithoutRun = (participants: readonly { role: string; caps?: readonly string[] }[]) =>
  participants.some((p) => p.role === "guest" && !!p.caps?.includes("edit") && !p.caps.includes("run"));
