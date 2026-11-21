/**
 * Code Together Git: what a guest may name, and the exact git command lines the host builds from it.
 * No state and no imports, so the security rules can be tested on their own. Guests never send
 * arguments: they send a path, a branch name or a message, and only the builders below make argv.
 */

/**
 * In front of every git command run for a guest. A guest can edit tracked files, so nothing in the
 * work tree may become code on the host: no hooks (core.hooksPath can point at a tracked folder), no
 * fsmonitor, no `ext::` transport, no submodule recursion (.gitmodules is guest-editable). Pathspecs
 * are literal, so `:(glob)` and friends are just file names. Signing stays off: the host's key
 * must not vouch for a guest's commit. `safe.bareRepository=explicit` comes from the backend's env.
 */
export const GIT_GUARD: readonly string[] = [
  "--no-pager",
  "--literal-pathspecs",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "protocol.ext.allow=never",
  "-c", "submodule.recurse=false",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "push.recurseSubmodules=no",
  "-c", "credential.interactive=never",
];

/** Network commands must fail rather than ask for a passphrase on the host's screen. */
export const SSH_BATCH: readonly string[] = ["-c", "core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=15"];

export const GIT_LIMITS = {
  maxPaths: 2000,
  maxPathsBytes: 512 * 1024,
  maxPath: 4096,
  maxBranch: 200,
  maxMessage: 64 * 1024,
  maxChanges: 5000,
  /** Per side of a diff, for the gutter's HEAD text and for a blamed buffer. */
  maxFile: 2 * 1024 * 1024,
};

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A file name that means the git folder, also as Windows/macOS spell it (see is_git_name in collab.rs). */
const isGitSegment = (seg: string) => {
  const base = seg.replace(/[‌-‏‪-‮⁪-⁯﻿]/g, "").split(":")[0].replace(/[. ]+$/, "").toLowerCase();
  return base === ".git" || base === "git~1";
};

/** A file path as a guest may name it: relative, plain, not an option, not in a git folder. */
export function validPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > GIT_LIMITS.maxPath || CONTROL.test(p) || p.includes("\\")) return false;
  if (p.startsWith("/") || p.startsWith("-") || p.startsWith(":") || /^[a-zA-Z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !isGitSegment(seg));
}

/** A checked, de-duplicated list of paths, or null. Bounded so it fits on a command line. */
export function validPaths(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > GIT_LIMITS.maxPaths || !raw.every(validPath)) return null;
  const paths = [...new Set(raw as string[])];
  return paths.reduce((n, p) => n + p.length + 1, 0) > GIT_LIMITS.maxPathsBytes ? null : paths;
}

/**
 * A branch name by the rules of `git check-ref-format`, stricter where it costs nothing. This also
 * refuses all revision syntax (`@{-1}`, `HEAD~1`, `a..b`, `x^{}`), so a name can only be a name.
 */
export function validBranch(name: unknown): name is string {
  if (typeof name !== "string" || !name || name.length > GIT_LIMITS.maxBranch) return false;
  if (CONTROL.test(name) || /[\s~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  // A leading "+" is a forced refspec to `git push`, "@" is shorthand for HEAD.
  if (name.startsWith("-") || name.startsWith("+") || name.startsWith("@") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name === "HEAD") return false;
  return name.split("/").every((seg) => !seg.startsWith(".") && !seg.startsWith("-") && !seg.endsWith(".lock"));
}

export const validMessage = (m: unknown): m is string => typeof m === "string" && !!m.trim() && m.length <= GIT_LIMITS.maxMessage && !m.includes("\0");

const guarded = (...args: string[]) => [...GIT_GUARD, ...args];

/** Every command a guest can cause. Paths are relative to the shared folder (the command's cwd). */
export const gitArgv = {
  stage: (paths: string[]) => guarded("add", "-A", "--", ...paths),
  unstage: (paths: string[]) => guarded("reset", "-q", "--", ...paths),
  /** Exactly these paths; whatever else the host has staged stays staged and out of the commit. */
  commit: (message: string, paths: string[]) => guarded("commit", "-q", "--no-verify", "--no-gpg-sign", `--message=${message}`, "--only", "--", ...paths),
  /** Concludes a merge, or replaces the message of the commit a rebase is replaying. */
  commitIndex: (message: string) => guarded("commit", "-q", "--no-verify", "--no-gpg-sign", ...(message ? [`--message=${message}`] : ["--no-edit"])),
  rebaseContinue: () => guarded("rebase", "--continue"),
  abort: (op: "merge" | "rebase") => guarded(op, "--abort"),
  discard: (paths: string[]) => guarded("restore", "--staged", "--worktree", "--source=HEAD", "--", ...paths),
  forget: (path: string) => guarded("rm", "-q", "--cached", "--ignore-unmatch", "--", path),
  createBranch: (name: string) => guarded("switch", "--no-guess", "-c", name),
  switchLocal: (name: string) => guarded("switch", "--no-guess", name),
  switchTrack: (remoteRef: string) => guarded("switch", "--track", remoteRef),
  hasRef: (ref: string) => guarded("show-ref", "--verify", "--quiet", ref),
  prefix: () => guarded("rev-parse", "--show-prefix"),
  headSha: () => guarded("rev-parse", "--verify", "-q", "HEAD"),
  origin: () => guarded("remote", "get-url", "origin"),
  ownSsh: () => guarded("config", "--get", "core.sshCommand"),
  branches: () => guarded("branch", "-a", "--format=%(refname:short)"),
  stagedAny: () => guarded("diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"),
  blobSize: (spec: string) => guarded("cat-file", "-s", spec),
  blob: (spec: string) => guarded("cat-file", "blob", spec),
  remotes: () => guarded("remote"),
  configGet: (key: string) => guarded("config", "--get", key),
  /** No remote or refspec comes from a guest: they only reach what the host has configured. */
  fetch: (ssh: readonly string[]) => [...GIT_GUARD, ...ssh, "fetch", "--quiet", "--no-recurse-submodules"],
  pull: (ssh: readonly string[]) => [...GIT_GUARD, ...ssh, "pull", "--autostash", "--no-edit", "--no-stat", "--no-recurse-submodules"],
  /**
   * Always one full refspec, never a bare name: a name could read as `+forced`, and without a refspec
   * the remote's configured ones apply, which may force. `to` is a full ref.
   */
  push: (ssh: readonly string[], remote: string, branch: string, to: string, track: boolean) => [
    ...GIT_GUARD, ...ssh, "push", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", ...(track ? ["-u"] : []), remote, `refs/heads/${branch}:${to}`,
  ],
};

export interface GitChange {
  path: string;
  x: string;
  y: string;
  orig: string | null;
}

/**
 * Repository-relative changes as the guest may see them: relative to the shared folder, without
 * anything outside it (the repository can be larger than the project) or in a git folder.
 */
export function scopeChanges(changes: GitChange[], prefix: string, allowed: (rel: string) => boolean) {
  const inside = (p: string) => (p.startsWith(prefix) && allowed(p.slice(prefix.length)) ? p.slice(prefix.length) : null);
  const out: GitChange[] = [];
  let truncated = false;
  for (const c of changes) {
    const path = inside(c.path);
    if (path === null || !path) continue;
    if (out.length >= GIT_LIMITS.maxChanges) {
      truncated = true;
      break;
    }
    out.push({ path, x: c.x, y: c.y, orig: c.orig ? inside(c.orig) : null });
  }
  return { changes: out, truncated };
}

/** A stable error code for a failed git command. Its text can hold absolute paths and stays on the host. */
export function gitFailCode(stderr: string): string {
  if (/would be overwritten|untracked working tree files/i.test(stderr)) return "would_overwrite";
  if (/CONFLICT|unmerged|not possible because you have unmerged|needs merge/i.test(stderr)) return "conflict";
  if (/nothing to commit|no changes added/i.test(stderr)) return "nothing_to_commit";
  if (/tell me who you are|unable to auto-detect email|empty ident/i.test(stderr)) return "identity";
  if (/no upstream|no tracking information|does not appear to be a git repository|No configured push destination/i.test(stderr)) return "no_upstream";
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(stderr)) return "rejected";
  if (/authentication failed|permission denied|could not read username|host key verification|could not resolve host|connection (timed out|refused)|unable to access/i.test(stderr)) return "auth";
  if (/already exists/i.test(stderr)) return "exists";
  return "failed";
}
