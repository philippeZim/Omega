/** State for the side-by-side diff (HEAD vs. working copy). */
export const diffState = $state({ file: null as string | null });

export function openDiff(file: string) {
  diffState.file = file;
}
