/**
 * Package suggestions for the "Add/Remove dependency" prompts (uv and pnpm projects).
 *
 * - Add: a curated list when the field is empty; while typing, PyPI names come from the public
 *   "top PyPI packages" list (fetched once, cached a week; PyPI itself has no search API) and
 *   npm names from the registry's search endpoint.
 * - Remove: the dependencies declared in pyproject.toml / package.json.
 */
import { fsApi, joinPath } from "../api";

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
    [...arr.matchAll(/["']([^"']+)["']/g)].map((m) => m[1].match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1]).filter((x): x is string => !!x);
  let section = "";
  // Arrays may span lines: walk "key = [ ... ]" blocks per section.
  const re = /^\s*\[([^\]]+)\]\s*$|^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*\[((?:"[^"]*"|'[^']*'|#[^\n]*|[^\]"'#])*)\]/gm;
  for (const m of text.matchAll(re)) {
    if (m[1]) {
      section = m[1].trim();
      continue;
    }
    const key = m[2].replace(/"/g, "");
    if (section === "project" && key === "dependencies") for (const n of names(m[3])) out.push({ name: n, group: "" });
    else if (section === "dependency-groups") for (const n of names(m[3])) out.push({ name: n, group: key });
    else if (section === "tool.uv" && key === "dev-dependencies") for (const n of names(m[3])) out.push({ name: n, group: "dev" });
  }
  return out;
}

export function suggestPythonAdd(root: string, dev: boolean): Suggest {
  return async (q) => {
    const installed = new Set((await pythonDeps(root)).map((d) => norm(d.name)));
    const curated = dev ? PY_DEV : PY_POPULAR;
    const desc = new Map([...PY_POPULAR, ...PY_DEV]);
    const tag = (n: string) => (installed.has(norm(n)) ? "installed" : undefined);
    if (!q.trim()) return curated.map(([value, detail]) => ({ value, detail, tag: tag(value) }));
    const names = rank(await loadPypiNames(), q.trim());
    return names.map((value) => ({ value, detail: desc.get(value), tag: tag(value) }));
  };
}

export function suggestPythonRemove(root: string): Suggest {
  return async (q) => {
    const deps = await pythonDeps(root);
    const hit = q.trim() ? rank(deps.map((d) => d.name), q.trim(), 200) : deps.map((d) => d.name);
    return hit.map((value) => ({ value, tag: deps.find((d) => d.name === value)?.group || undefined }));
  };
}

/** `uv remove` needs `--dev`/`--group` for packages outside the main dependency list. */
export async function pythonRemoveArg(root: string, input: string): Promise<string> {
  const deps = await pythonDeps(root);
  const parts = input.split(/\s+/).filter(Boolean);
  if (parts.some((p) => p.startsWith("-"))) return input; // user passed flags themselves
  const groups = new Set(parts.map((p) => deps.find((d) => norm(d.name) === norm(p))?.group ?? ""));
  if (groups.size !== 1) return input;
  const g = [...groups][0];
  return g === "" ? input : g === "dev" ? `--dev ${input}` : `--group ${g} ${input}`;
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
      return objs.map((o) => ({ value: o.package.name, detail: o.package.description, tag: tag(o.package.name) }));
    } catch {
      return rank([...NPM_POPULAR, ...NPM_DEV].map(([n]) => n), q.trim()).map((value) => ({ value, tag: tag(value) }));
    }
  };
}

export function suggestNodeRemove(root: string): Suggest {
  return async (q) => {
    const deps = await nodeDeps(root);
    const hit = q.trim() ? rank(deps.map((d) => d.name), q.trim(), 200) : deps.map((d) => d.name);
    return hit.map((value) => ({ value, tag: deps.find((d) => d.name === value)?.dev ? "dev" : undefined }));
  };
}
