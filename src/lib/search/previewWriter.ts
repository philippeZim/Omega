/**
 * Delayed writes of the Find in Files preview to disk (for files that aren't open in a tab).
 * Only an edit made in the preview schedules a write; closing the popup flushes just that pending
 * write, so a file that changed on disk meanwhile is never overwritten with the stale preview.
 */
export function previewWriter(write: (file: string, text: string) => unknown, delay = 600) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { file: string; text: () => string } | null = null;

  const run = async () => {
    clearTimeout(timer);
    timer = undefined;
    const p = pending;
    pending = null;
    if (p) await write(p.file, p.text());
  };

  return {
    /** Writes `text()` to `file` after `delay` ms; a newer call replaces the pending one. */
    schedule(file: string, text: () => string) {
      clearTimeout(timer);
      pending = { file, text };
      timer = setTimeout(run, delay);
    },
    /** Drops a pending write (e.g. the preview switched files). */
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending = null;
    },
    /** Writes a pending edit right away (resolves when written); does nothing if there is none. */
    flush: run,
  };
}
