/**
 * Project search of a Code Together guest, as the search UI sees it. A leaf module: the session
 * code (collab/projectSearch.svelte.ts) plugs in, so the search UI loads no collab code itself.
 * Paths are the guest's tab paths ("collab:<relative path>").
 */
import type { Hit } from "./search.svelte";

export interface RemoteQuery {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  mask: string;
  /** Relative folder, "" = the project. */
  folder: string;
  /** Scope "open files": these tab paths only. */
  files?: string[];
  maxResults: number;
}

export interface ReplaceReport {
  replaced: number;
  /** Files that were changed. */
  changed: number;
  errors: { file: string; message: string }[];
  /** Why the run ended early (rights revoked, session over, cancelled). */
  stopped: string | null;
  /** Files handled before it ended. */
  done: number;
}

export type RemoteResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface RemoteSearch {
  active(): boolean;
  /** Whether this guest may change files (says so if not). */
  mayReplace(): boolean;
  listFiles(signal?: AbortSignal): Promise<RemoteResult<{ files: string[]; truncated: boolean }>>;
  text(q: RemoteQuery, signal?: AbortSignal): Promise<RemoteResult<{ hits: Hit[]; files: number; total: number; truncated: boolean }>>;
  matching(q: RemoteQuery): Promise<RemoteResult<{ files: string[]; truncated: boolean }>>;
  read(file: string): Promise<string | null>;
  replace(q: RemoteQuery, replacement: string, files: string[], line?: number): Promise<ReplaceReport>;
  reveal(file: string, line: number, range?: [number, number]): Promise<void>;
}

export const remoteSearch: { backend: RemoteSearch | null } = { backend: null };

/** The guest's search while in a session, otherwise null (the local search applies). */
export const activeRemote = () => (remoteSearch.backend?.active() ? remoteSearch.backend : null);
