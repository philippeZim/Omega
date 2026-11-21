/** Where a Code Together guest's language features plug in (a leaf: modes.ts can't load the session). */
import type { Extension } from "@codemirror/state";
import type { WorkspaceSymbol } from "./lsp.svelte";

export const remoteLsp = {
  /** Editor extension for a shared file (relative path); set by collab/lspGuest.svelte.ts. */
  extension: null as ((rel: string) => Extension) | null,
  /** Workspace symbols from the host while connected as a guest (`path` is a "collab:" path). */
  symbols: null as ((query: string) => Promise<WorkspaceSymbol[]>) | null,
};
