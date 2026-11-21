import { lineDiff } from "./lineDiff";
/** State for the side-by-side diff (HEAD vs. working copy). */
export const diffState = $state({ file: null as string | null });

export function openDiff(file: string) {
  diffState.file = file;
}

/** Diff options for the side-by-side view: lines first, then characters within changed lines (#74). */
export const DIFF_CONFIG = { override: lineDiff };
