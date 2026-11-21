/**
 * Package suggestions for the "Add/Remove dependency" prompts (uv and pnpm projects).
 *
 * - Add: a curated list when the field is empty; while typing, PyPI names come from the public
 *   "top PyPI packages" list (fetched once, cached a week; PyPI itself has no search API) and
 *   npm names from the registry's search endpoint.
 * - Remove: the dependencies declared in pyproject.toml / package.json.
 */
import { fsApi, joinPath } from "../api";
import { t } from "../i18n/index.svelte";
import { quotePackageArg, validGroupName, validPackage } from "./packageInput";

export interface Suggestion {
  /** Text put into the input field. */
  value: string;
  detail?: string;
  /** Small badge, e.g. "dev" or "installed". */
  tag?: string;
}

export type Suggest = (query: string) => Promise<Suggestion[]>;

const LIMIT = 40;

// ------------------------------------------------------------------ curated lists

const PY_POPULAR: [string, string][] = [
  ["requests", "HTTP for humans"],
  ["httpx", "Async-capable HTTP client"],
  ["numpy", "Arrays and numerical computing"],
  ["pandas", "Data frames and data analysis"],
  ["polars", "Fast data frames"],
  ["matplotlib", "Plotting"],
  ["seaborn", "Statistical plots"],
  ["scipy", "Scientific computing"],
  ["scikit-learn", "Machine learning"],
  ["torch", "PyTorch deep learning"],
  ["pillow", "Image processing"],
  ["fastapi", "Web APIs"],
  ["uvicorn", "ASGI server (for FastAPI)"],
  ["flask", "Lightweight web framework"],
  ["django", "Full-stack web framework"],
  ["pydantic", "Data validation with type hints"],
  ["sqlalchemy", "SQL toolkit and ORM"],
  ["beautifulsoup4", "HTML parsing"],
  ["rich", "Pretty terminal output"],
  ["typer", "Command-line apps"],
  ["click", "Command-line apps"],
  ["python-dotenv", "Load .env files"],
  ["pyyaml", "YAML"],
  ["tqdm", "Progress bars"],
  ["openai", "OpenAI API client"],
  ["anthropic", "Claude API client"],
];

const PY_DEV: [string, string][] = [
  ["pytest", "Testing"],
  ["pytest-cov", "Test coverage for pytest"],
  ["ruff", "Linter and formatter"],
  ["mypy", "Static type checking"],
  ["basedpyright", "Static type checking"],
  ["ipython", "Interactive shell"],
  ["ipykernel", "Jupyter kernel"],
  ["pre-commit", "Git hooks"],
  ["coverage", "Code coverage"],
  ["hypothesis", "Property-based testing"],
];

const NPM_POPULAR: [string, string][] = [
  ["zod", "Schema validation"],
  ["react", "UI library"],
  ["react-dom", "React for the browser"],
  ["svelte", "UI compiler"],
  ["vue", "UI framework"],
  ["express", "Web server"],
  ["hono", "Small web framework"],
  ["axios", "HTTP client"],
  ["lodash-es", "Utility functions"],
  ["date-fns", "Date utilities"],
  ["dayjs", "Small date library"],
  ["uuid", "UUIDs"],
  ["dotenv", "Load .env files"],
  ["chalk", "Terminal colours"],
  ["commander", "Command-line apps"],
  ["tailwindcss", "Utility-first CSS"],
];

const NPM_DEV: [string, string][] = [
  ["typescript", "TypeScript compiler"],
  ["vitest", "Testing"],
  ["@types/node", "Node.js type definitions"],
  ["eslint", "Linter"],
  ["prettier", "Formatter"],
  ["vite", "Dev server and bundler"],
  ["tsx", "Run TypeScript directly"],
  ["@playwright/test", "End-to-end tests"],
];

// ------------------------------------------------------------------ matching

/** Prefix matches first (in list order, i.e. by popularity), then substring matches. */
function rank(names: string[], q: string, limit = LIMIT): string[] {
  const n = q.toLowerCase().replace(/_/g, "-");
  const pre: string[] = [], sub: string[] = [];
  for (const name of names) {
    const k = name.toLowerCase().replace(/_/g, "-");
    if (k.startsWith(n)) pre.push(name);
    else if (k.includes(n)) sub.push(name);
    if (pre.length >= limit) break;
  }
  return [...pre, ...sub].slice(0, limit);
}

const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");

// ------------------------------------------------------------------ PyPI

const PYPI_KEY = "pypiTopNames";
const PYPI_URL = "https://hugovk.dev/top-pypi-packages/top-pypi-packages.min.json";
let pypiNames: Promise<string[]> | null = null;

function loadPypiNames(): Promise<string[]> {
  pypiNames ??= (async () => {
    try {
      const cached = JSON.parse(localStorage.getItem(PYPI_KEY) || "null") as { at: number; names: string } | null;
      if (cached && Date.now() - cached.at < 7 * 864e5) return cached.names.split("\n");
    } catch {}
    try {
      const r = await fetch(PYPI_URL);
      const rows = ((await r.json()) as { rows: { project: string }[] }).rows;
      const names = rows.map((x) => x.project);
      try {
        localStorage.setItem(PYPI_KEY, JSON.stringify({ at: Date.now(), names: names.join("\n") }));
      } catch {}
      return names;
    } catch {
      pypiNames = null; // offline: retry next time, use the curated list meanwhile
      return [...PY_POPULAR, ...PY_DEV].map(([n]) => n);
    }
  })();
  return pypiNames;
}

/**
 * Top-level string items of a TOML array body (the text between `[` and `]`).
 * Skips `#` comments (a `#` inside a string is not a comment) and inline tables
 * such as `{ include-group = "test" }`.
 */
function arrayStrings(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "#") {
      while (i < body.length && body[i] !== "\n") i++;
    } else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === '"' || c === "'") {
      let v = "";
      for (i++; i < body.length && body[i] !== c && body[i] !== "\n"; i++) {
        // Basic strings support backslash escapes; literal ('...') strings don't.
        if (c === '"' && body[i] === "\\" && i + 1 < body.length) i++;
        v += body[i];
      }
      if (depth === 0) out.push(v);
    }
  }
  return out;
}

/** Index of the `]` closing an array body that starts at `from`, skipping strings and comments; -1 if none. */
function arrayEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "]") return i;
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (c === '"' && text[i] === "\\") i++;
    }
  }
  return -1;
}

/** Dependency names declared in pyproject.toml, with the group they belong to ("" = main). */
export async function pythonDeps(root: string): Promise<{ name: string; group: string }[]> {
  let text: string;
  try {
    text = await fsApi.readFile(joinPath(root, "pyproject.toml"));
  } catch {
    return [];
  }
  const out: { name: string; group: string }[] = [];
  const names = (arr: string) =>
    arrayStrings(arr).map((v) => v.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1]).filter((x): x is string => !!x);
  let section = "";
  // Arrays may span lines: find "key = [" by regex, then scan for the closing `]`
  // (a backtracking regex over the body hangs on unterminated arrays with comments).
  const re = /^\s*\[([^\]]+)\]\s*$|^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*\[/gm;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m[1]) {
      section = m[1].trim();
      continue;
    }
    const end = arrayEnd(text, re.lastIndex);
    if (end < 0) continue; // unterminated (e.g. while typing): not a dependency list
    const body = text.slice(re.lastIndex, end);
    re.lastIndex = end + 1;
    const key = m[2].replace(/"/g, "");
    if (section === "project" && key === "dependencies") for (const n of names(body)) out.push({ name: n, group: "" });
    else if (section === "dependency-groups") for (const n of names(body)) out.push({ name: n, group: key });
    else if (section === "tool.uv" && key === "dev-dependencies") for (const n of names(body)) out.push({ name: n, group: "dev" });
  }
  return out;
}

// A picked suggestion goes into the command line, and these lists come from project files and the
// registries, so only real package names are offered.
const isPyName = (n: string) => validPackage("uv", "remove", n);
const isNodeName = (n: string) => validPackage("pnpm", "remove", n);

export function suggestPythonAdd(root: string, dev: boolean): Suggest {
  return async (q) => {
    const installed = new Set((await pythonDeps(root)).map((d) => norm(d.name)));
    const curated = dev ? PY_DEV : PY_POPULAR;
    const desc = new Map([...PY_POPULAR, ...PY_DEV]);
    const tag = (n: string) => (installed.has(norm(n)) ? "installed" : undefined);
    if (!q.trim()) return curated.map(([value, detail]) => ({ value, detail, tag: tag(value) }));
    const names = rank((await loadPypiNames()).filter(isPyName), q.trim());
    return names.map((value) => ({ value, detail: desc.get(value), tag: tag(value) }));
  };
}

export function suggestPythonRemove(root: string): Suggest {
  return async (q) => {
    const deps = (await pythonDeps(root)).filter((d) => isPyName(d.name));
    const hit = q.trim() ? rank(deps.map((d) => d.name), q.trim(), 200) : deps.map((d) => d.name);
    return hit.map((value) => ({ value, tag: deps.find((d) => d.name === value)?.group || undefined }));
  };
}

/** `uv remove` needs `--dev`/`--group` for packages outside the main dependency list. */
export async function pythonRemoveArg(root: string, input: string): Promise<string> {
  const deps = await pythonDeps(root);
  const parts = input.split(/\s+/).filter(Boolean);
  if (parts.some((p) => p.startsWith("-"))) return input; // user passed flags themselves
  const g = removeGroup(deps, parts);
  if (!g) return input;
  if (g === "dev") return `--dev ${input}`;
  // The name comes from pyproject.toml, which isn't necessarily the host's own text.
  if (!validGroupName(g)) throw new Error(t("code.act.badGroup"));
  return `--group ${quotePackageArg(g)} ${input}`;
}

/** The one group all these packages are in; null when they're in the main list or in several. */
function removeGroup(deps: { name: string; group: string }[], names: string[]): string | null {
  const groups = new Set(names.map((p) => deps.find((d) => norm(d.name) === norm(p))?.group ?? ""));
  return groups.size === 1 ? [...groups][0] || null : null;
}

/**
 * `uv remove` flags as separate words, for names from a Code Together guest. Null when the group
 * name isn't a plain one: anybody who can edit pyproject.toml chooses it.
 */
export async function pythonRemoveFlags(root: string, names: string[]): Promise<string[] | null> {
  const g = removeGroup(await pythonDeps(root), names);
  if (!g) return [];
  if (g === "dev") return ["--dev"];
  return validGroupName(g) ? ["--group", quotePackageArg(g)] : null;
}

// ------------------------------------------------------------------ npm

export async function nodeDeps(root: string): Promise<{ name: string; dev: boolean }[]> {
  try {
    const pkg = JSON.parse(await fsApi.readFile(joinPath(root, "package.json")));
    return [
      ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, dev: false })),
      ...Object.keys(pkg.devDependencies ?? {}).map((name) => ({ name, dev: true })),
    ];
  } catch {
    return [];
  }
}

export function suggestNodeAdd(root: string, dev: boolean): Suggest {
  return async (q) => {
    const installed = new Set((await nodeDeps(root)).map((d) => d.name));
    const tag = (n: string) => (installed.has(n) ? "installed" : undefined);
    if (!q.trim()) return (dev ? NPM_DEV : NPM_POPULAR).map(([value, detail]) => ({ value, detail, tag: tag(value) }));
    try {
      const r = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q.trim())}&size=20`);
      const objs = ((await r.json()) as { objects: { package: { name: string; description?: string } }[] }).objects;
      return objs.filter((o) => isNodeName(o.package.name)).map((o) => ({ value: o.package.name, detail: o.package.description, tag: tag(o.package.name) }));
    } catch {
      return rank([...NPM_POPULAR, ...NPM_DEV].map(([n]) => n), q.trim()).map((value) => ({ value, tag: tag(value) }));
    }
  };
}

export function suggestNodeRemove(root: string): Suggest {
  return async (q) => {
    const deps = (await nodeDeps(root)).filter((d) => isNodeName(d.name));
    const hit = q.trim() ? rank(deps.map((d) => d.name), q.trim(), 200) : deps.map((d) => d.name);
    return hit.map((value) => ({ value, tag: deps.find((d) => d.name === value)?.dev ? "dev" : undefined }));
  };
}
