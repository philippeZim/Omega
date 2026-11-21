import { beforeEach, describe, expect, test } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { nodeDeps, pythonDeps, pythonRemoveArg, pythonRemoveFlags, suggestNodeRemove, suggestPythonRemove } from "./packages";

let files: Record<string, string> = {};
beforeEach(() => {
  files = {};
  mockIPC((cmd, args) => {
    const path = (args as { path?: string })?.path ?? "";
    if (cmd === "read_file") {
      if (path in files) return files[path];
      throw new Error("not found");
    }
    if (cmd === "path_exists") return path in files;
    return null;
  });
});

const PYPROJECT = `[project]
name = "demo"
requires-python = ">=3.12"
dependencies = [
    "requests>=2.31",
    'numpy',  # arrays
    "Pillow[extra] ; python_version > '3.8'",
]

[project.optional-dependencies]
cli = ["typer"]

[dependency-groups]
dev = ["pytest>=8", "ruff"]
"docs" = [
  "mkdocs",
]

[tool.uv]
dev-dependencies = ["mypy"]
`;

describe("pythonDeps", () => {
  test("main deps, dependency groups and tool.uv dev-dependencies", async () => {
    files["/p/pyproject.toml"] = PYPROJECT;
    expect(await pythonDeps("/p")).toEqual([
      { name: "requests", group: "" },
      { name: "numpy", group: "" },
      { name: "Pillow", group: "" },
      { name: "pytest", group: "dev" },
      { name: "ruff", group: "dev" },
      { name: "mkdocs", group: "docs" },
      { name: "mypy", group: "dev" },
    ]);
  });

  test("a comment containing ] does not end the array", async () => {
    files["/p/pyproject.toml"] = `[project]\ndependencies = [\n  "a", # see [docs]\n  "b",\n]\n`;
    expect((await pythonDeps("/p")).map((d) => d.name)).toEqual(["a", "b"]);
  });

  test("missing pyproject → []", async () => {
    expect(await pythonDeps("/nope")).toEqual([]);
  });

  test("quotes inside comments are ignored", async () => {
    files["/p/pyproject.toml"] = `[project]\ndependencies = [\n  "a", # don't 'pin' this\n]\n`;
    expect((await pythonDeps("/p")).map((d) => d.name)).toEqual(["a"]);
  });

  test("include-group entries are not packages", async () => {
    files["/p/pyproject.toml"] = `[dependency-groups]\ndev = [{ include-group = "test" }, "ruff"]\n`;
    expect((await pythonDeps("/p")).map((d) => d.name)).toEqual(["ruff"]);
  });

  test("a # inside a string is not a comment", async () => {
    files["/p/pyproject.toml"] = `[project]\ndependencies = [\n  "pkg @ https://x/#egg=pkg", "b", # 'c'\n  "d",\n]\n`;
    expect((await pythonDeps("/p")).map((d) => d.name)).toEqual(["pkg", "b", "d"]);
  });

  test("single-quoted strings are read", async () => {
    files["/p/pyproject.toml"] = `[project]\ndependencies = ['requests>=2', 'my-lib @ file:///x#frag', "httpx"]\n`;
    expect((await pythonDeps("/p")).map((d) => d.name)).toEqual(["requests", "my-lib", "httpx"]);
  });

  test("unterminated array with comments doesn't hang (#95)", async () => {
    const comments = Array.from({ length: 6 }, (_, i) => `  # comment number ${i}\n`).join("");
    files["/p/pyproject.toml"] = `[project]\ndependencies = ["a"]\n\n[dependency-groups]\ndev = [\n  "b",\n${comments}`;
    const t0 = performance.now();
    expect((await pythonDeps("/p")).map((d) => d.name)).toEqual(["a"]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("pythonRemoveArg", () => {
  beforeEach(() => {
    files["/p/pyproject.toml"] = PYPROJECT;
  });
  test("adds --dev / --group for non-main deps (name-normalized)", async () => {
    expect(await pythonRemoveArg("/p", "requests")).toBe("requests");
    expect(await pythonRemoveArg("/p", "pytest")).toBe("--dev pytest");
    expect(await pythonRemoveArg("/p", "MkDocs")).toBe("--group docs MkDocs");
  });
  test("leaves mixed groups and explicit flags alone", async () => {
    expect(await pythonRemoveArg("/p", "requests pytest")).toBe("requests pytest");
    expect(await pythonRemoveArg("/p", "--group x pytest")).toBe("--group x pytest");
  });
});

describe("nodeDeps", () => {
  test("dependencies and devDependencies", async () => {
    files["/n/package.json"] = JSON.stringify({ dependencies: { zod: "^3" }, devDependencies: { vitest: "^1", "@types/node": "*" } });
    expect(await nodeDeps("/n")).toEqual([
      { name: "zod", dev: false },
      { name: "vitest", dev: true },
      { name: "@types/node", dev: true },
    ]);
  });
  test("missing or invalid package.json → []", async () => {
    expect(await nodeDeps("/n")).toEqual([]);
    files["/n/package.json"] = "{ not json";
    expect(await nodeDeps("/n")).toEqual([]);
  });
});

describe("remove suggestions", () => {
  test("python: rank by prefix then substring, tag group", async () => {
    files["/p/pyproject.toml"] = PYPROJECT;
    const s = suggestPythonRemove("/p");
    expect((await s("")).length).toBe(7);
    expect(await s("py")).toEqual([{ value: "pytest", tag: "dev" }, { value: "numpy", tag: undefined }, { value: "mypy", tag: "dev" }]);
  });
  test("node: dev tag", async () => {
    files["/n/package.json"] = JSON.stringify({ dependencies: { zod: "1" }, devDependencies: { vitest: "1" } });
    expect(await suggestNodeRemove("/n")("vi")).toEqual([{ value: "vitest", tag: "dev" }]);
    expect(await suggestNodeRemove("/n")("zo")).toEqual([{ value: "zod", tag: undefined }]);
  });
});

describe("project files can't put shell text into a package command", () => {
  const ATTACKS = ["x; touch /tmp/pwned #", "x$(id)", "x`id`", "x|id", "x&id", "-x", "--index=evil", "a b", "x'y", "x\\ny"];

  test.each(ATTACKS)("uv remove refuses the group %j", async (group) => {
    files["/p/pyproject.toml"] = `[project]\nname = "x"\n\n[dependency-groups]\n"${group}" = ["evil"]\n`;
    await expect(pythonRemoveArg("/p", "evil")).rejects.toThrow(/group/i);
    expect(await pythonRemoveFlags("/p", ["evil"])).toBeNull();
  });

  test.each(["docs", "Docs_2", "test.unit", "a-b"])("uv remove accepts the group %s", async (group) => {
    files["/p/pyproject.toml"] = `[project]\nname = "x"\n\n[dependency-groups]\n"${group}" = ["pkg"]\n`;
    expect(await pythonRemoveArg("/p", "pkg")).toBe(`--group ${group} pkg`);
    expect(await pythonRemoveFlags("/p", ["pkg"])).toEqual(["--group", group]);
  });

  test("remove suggestions only offer real package names", async () => {
    files["/n/package.json"] = JSON.stringify({ dependencies: { zod: "1", "x; touch /tmp/pwned": "1", "$(id)": "1", "-x": "1" }, devDependencies: { "@types/node": "1", "a b": "1" } });
    expect((await suggestNodeRemove("/n")("")).map((s) => s.value)).toEqual(["zod", "@types/node"]);
    expect(await suggestNodeRemove("/n")("touch")).toEqual([]);
    files["/p/pyproject.toml"] = `[project]\ndependencies = ["requests", "foo.whl", "ok>=1"]\n`;
    expect((await suggestPythonRemove("/p")("")).map((s) => s.value)).toEqual(["requests", "ok"]);
  });
});
