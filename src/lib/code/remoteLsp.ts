/** Where a Code Together guest's language features plug in (a leaf: modes.ts can't load the session). */
import type { Extension } from "@codemirror/state";
import type { WorkspaceSymbol } from "./lsp.svelte";

export const remoteLsp = {
  /** Editor extension for a shared file (relative path); set by collab/lspGuest.svelte.ts. */
  extension: null as ((rel: string) => Extension) | null,
  /** Workspace symbols from the host while connected as a guest ("collab:" paths), else null. */
  symbols: null as ((query: string) => Promise<WorkspaceSymbol[] | null>) | null,
  /** Opens a shared file at a position (1-based line and column). */
  openAt: null as ((path: string, line: number, col: number) => Promise<void>) | null,
};
