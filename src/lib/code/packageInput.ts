/**
 * Which project actions change packages, and the package text a Code Together guest may send.
 *
 * The Run terminal takes a shell string, so a guest's input is held to a strict grammar per
 * ecosystem on the host: registry names with optional extras and version requirements. Links,
 * paths, git sources, options and anything else a tool would read as more than a registry package
 * are refused. What passes is quoted as one word by `quotePackageArg`.
 */
import { IS_WIN } from "../platform";
import type { ProjectKind } from "./projects";

export type PackageInput = "add" | "remove";
export interface PackageAction {
  /** What the action asks for; null: it runs without input (sync, install, ...). */
  input: PackageInput | null;
  /** Example for the prompt. */
  example?: string;
}

const ACTIONS: Partial<Record<ProjectKind, Record<string, PackageAction>>> = {
  cargo: { add: { input: "add", example: "serde" }, update: { input: null } },
  uv: {
    sync: { input: null },
    lock: { input: null },
    add: { input: "add", example: "requests" },
    adddev: { input: "add", example: "pytest" },
    remove: { input: "remove" },
  },
  pnpm: {
    install: { input: null },
    add: { input: "add", example: "zod" },
    adddev: { input: "add", example: "vitest" },
    remove: { input: "remove" },
  },
};

/** The package action behind an id, or null. Ids come from guests, so only own keys count. */
export function packageAction(kind: string, id: string): PackageAction | null {
  const table = Object.hasOwn(ACTIONS, kind) ? ACTIONS[kind as ProjectKind] : undefined;
  return table && Object.hasOwn(table, id) ? table[id] : null;
}

export const PACKAGE_LIMITS = { count: 20, length: 200 };

/** Tools read these as local or remote archives, even when the text looks like a name. */
const ARCHIVE = /\.(?:whl|zip|tgz|tar|gz|bz2|xz|egg)$/i;

const PY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PY_VERSION = /^(?:\d+!)?\d+(?:\.\d+)*(?:\.\*|(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview|post|rev|r|dev)[-_.]?\d*){0,3}(?:\+[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*)?)$/i;
const PY_CLAUSE = /^(===|==|~=|!=|<=|>=|<|>)(.+)$/;

function validPython(token: string, input: PackageInput) {
  const m = /^([^[\]<>=!~,]+)(?:\[([^\]]*)\])?(.*)$/.exec(token);
  if (!m || !PY_NAME.test(m[1]) || ARCHIVE.test(m[1])) return false;
  const [, , extras, spec] = m;
  if (input === "remove") return extras === undefined && spec === "";
  if (extras !== undefined && !extras.split(",").every((x) => PY_NAME.test(x))) return false;
  if (!spec) return true;
  const clauses = spec.split(",");
  return clauses.length <= 4 && clauses.every((c) => {
    const v = PY_CLAUSE.exec(c);
    return !!v && PY_VERSION.test(v[2]);
  });
}

const NPM_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NPM_RANGE = /^(?:[\^~]|>=|<=|>|<|=)?v?\d+(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

function validNode(token: string, input: PackageInput) {
  const at = token.indexOf("@", 1); // a leading @ belongs to the scope
  const name = at < 0 ? token : token.slice(0, at);
  if (name.length > 214 || !NPM_NAME.test(name) || ARCHIVE.test(name)) return false;
  if (at < 0) return true;
  if (input === "remove") return false;
  const spec = token.slice(at + 1);
  return spec === "*" || NPM_RANGE.test(spec) || (NPM_TAG.test(spec) && !ARCHIVE.test(spec));
}

const CRATE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CARGO_REQ = /^(?:=|>=|<=|>|<|~|\^)?\d+(?:\.(?:\d+|\*)){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validCargo(token: string, input: PackageInput) {
  const at = token.indexOf("@");
  const name = at < 0 ? token : token.slice(0, at);
  if (!CRATE.test(name)) return false;
  if (at < 0) return true;
  if (input === "remove") return false;
  const reqs = token.slice(at + 1).split(",");
  return reqs.length <= 4 && reqs.every((r) => CARGO_REQ.test(r));
}

/** Whether one word is a registry package in this project's ecosystem. */
export function validPackage(kind: string, input: PackageInput, token: string): boolean {
  if (typeof token !== "string" || !token || token.length > PACKAGE_LIMITS.length) return false;
  if (kind === "uv") return validPython(token, input);
  if (kind === "pnpm") return validNode(token, input);
  if (kind === "cargo") return validCargo(token, input);
  return false;
}

export const validPackages = (kind: string, input: PackageInput, tokens: string[]) =>
  tokens.length > 0 && tokens.length <= PACKAGE_LIMITS.count && tokens.every((x) => validPackage(kind, input, x));

export const splitPackages = (text: string) => text.split(/\s+/).filter(Boolean);

/**
 * One shell word for a validated package. The grammar above excludes both quote characters, `$`,
 * `%`, backslash, backtick and all whitespace, so nothing can end or expand the quoted word.
 */
export function quotePackageArg(token: string, windows = IS_WIN): string {
  if (/^[A-Za-z0-9._@/-]+$/.test(token)) return token;
  return windows ? `"${token}"` : `'${token}'`;
}
