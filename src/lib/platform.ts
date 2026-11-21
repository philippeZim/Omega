/**
 * OS differences in one place: which OS we run on, executable names, temp folder, and the
 * dialect of the "Run" terminal (POSIX shell on macOS/Linux, cmd.exe on Windows).
 *
 * Paths in the frontend always use "/" (the Rust side normalises Windows paths), e.g.
 * "C:/Users/me/proj". Only commands typed into cmd.exe get backslashes.
 */
import { invoke } from "@tauri-apps/api/core";

export type OS = "windows" | "macos" | "linux";

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const OS: OS = /Windows/i.test(ua) ? "windows" : /Mac OS X|Macintosh/i.test(ua) ? "macos" : "linux";
export const IS_WIN = OS === "windows";
export const IS_MAC = OS === "macos";

export interface PlatformInfo {
  os: OS;
  arch: string;
  home: string;
  tmp: string;
  tools: string;
}

let info: Promise<PlatformInfo> | null = null;
export function platform(): Promise<PlatformInfo> {
  return (info ??= invoke<PlatformInfo>("platform_info").then((p) => ({ ...p, tmp: p.tmp.replace(/\/+$/, "") })));
}

/** `name` + ".exe" on Windows. */
export const exe = (name: string) => (IS_WIN ? `${name}.exe` : name);

/** Temp file path for build outputs / generated files. */
export async function tmpPath(name: string) {
  return `${(await platform()).tmp}/${name}`;
}

/** Python inside a virtualenv folder. */
export const venvPython = (venv: string) => (IS_WIN ? `${venv}/Scripts/python.exe` : `${venv}/bin/python`);

// ------------------------------------------------------------------ Run-terminal dialect

/** A Unicode noncharacter: what `q` returns instead of a value cmd.exe can't be given safely. */
const UNQUOTABLE = "﷐";

const hasControl = (s: string) => /[\x00-\x1f\x7f-\x9f]/.test(s);

/**
 * Quotes an argument (a path or word) for the Run terminal. On Windows that is cmd.exe running a
 * batch file. `%` expands even inside double quotes, and `%%` only protects one parsing pass: a
 * `.cmd` wrapper that uses `call` expands it again. So such a value never reaches the command:
 * it's replaced by a marker, and `hasUnquotable` commands are refused.
 */
export function q(s: string): string {
  if (IS_WIN) {
    if (hasControl(s) || /[%"]/.test(s)) return UNQUOTABLE;
    const w = /^[A-Za-z]:\//.test(s) || s.startsWith("./") ? s.replace(/\//g, "\\") : s;
    return /^[\w@+=:,.\\-]+$/.test(w) ? w : `"${w}"`;
  }
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Whether a command contains a value `q` refused. It must not be run. */
export const hasUnquotable = (cmd: string) => cmd.includes(UNQUOTABLE);

/**
 * Whether a file name from another machine can go into a command through `q`. Control characters
 * would act on the terminal, and cmd.exe expands `%` even inside quotes. `!` is refused too: Omega
 * turns delayed expansion off, but a `.cmd` wrapper can turn it back on.
 */
export const quotablePath = (s: string, windows = IS_WIN) => !hasControl(s) && !(windows && /[%"!]/.test(s));

/** Changes into `dir` (also switching drives on Windows). */
export const cd = (dir: string) => (IS_WIN ? `cd /d ${q(dir)}` : `cd ${q(dir)}`);

/** Runs a program given by a path relative to the cwd (e.g. "build/app"). */
export const runRel = (rel: string) => q(`./${rel}`);

/** Runs `cmd` only if `file` (relative to cwd) does not exist. */
export const unlessExists = (file: string, cmd: string) =>
  IS_WIN ? `(if not exist ${q(`./${file}`)} (${cmd}))` : `{ [ -e ${q(file)} ] || ${cmd}; }`;

/** Deletes a folder recursively. */
export const rmrf = (dir: string) => (IS_WIN ? `rmdir /s /q ${q(`./${dir}`)}` : `rm -rf ${q(dir)}`);

/** Clears the line typed at the prompt before a command is sent (Ctrl+U / Esc). */
export const CLEAR_LINE = IS_WIN ? "\x1b" : "\x15";
