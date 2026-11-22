/** "1.5 GB": a file size for messages about large files (#174). */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 || n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} ${units[i]}`;
}

/** Largest text read whole without a warning, and all a Code Together guest can ever get (fs.rs). */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;

export const byteLength = (text: string) => new TextEncoder().encode(text).length;
