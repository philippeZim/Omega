import { beforeEach, describe, expect, test } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { cmakeExecutable, detectProject, findPythonMain, pyprojectScripts, pythonEntry, TEMPLATES, uvRunTarget } from "./projects";
import { i18n } from "../i18n/index.svelte";

let files: Record<string, string> = {};
beforeEach(() => {
  files = {};
  mockIPC((cmd, args) => {
    const path = (args as { path?: string })?.path ?? "";
    switch (cmd) {
      case "read_file":
        if (path in files) return files[path];
        throw new Error("not found");
      case "path_exists":
        return path in files;
      case "list_dir": {
        // Direct children of `path`, derived from the file map.
        const names = new Map<string, boolean>();
        for (const f of Object.keys(files)) {
          if (!f.startsWith(path + "/")) continue;
          const [name, ...more] = f.slice(path.length + 1).split("/");
          names.set(name, more.length > 0 || !!names.get(name));
        }
        return [...names].map(([name, is_dir]) => ({ name, path: `${path}/${name}`, is_dir }));
      }
      case "platform_info":
        return { os: "linux", arch: "x86_64", home: "/home/me", tmp: "/tmp/", tools: "/tools" };
      default:
        return null; // which_cmd → not installed
    }
  });
});

describe("pyprojectScripts", () => {
  test("reads [project.scripts] up to the next section", async () => {
    files["/p/pyproject.toml"] = `[project]\nname = "x"\n\n[project.scripts]\ndemo = "demo.cli:main"\n"other-tool" = 'demo.other:run'\n\n[build-system]\nfoo = "bar:baz"\n`;
    expect(await pyprojectScripts("/p")).toEqual([
      { name: "demo", target: "demo.cli:main" },
      { name: "other-tool", target: "demo.other:run" },
    ]);
  });
  test("section at the end of the file", async () => {
    files["/p/pyproject.toml"] = `[project.scripts]\napp = "app:main"`;
    expect(await pyprojectScripts("/p")).toEqual([{ name: "app", target: "app:main" }]);
  });
  test("none / missing file", async () => {
    files["/p/pyproject.toml"] = `[project]\nname = "x"\n`;
    expect(await pyprojectScripts("/p")).toEqual([]);
    expect(await pyprojectScripts("/missing")).toEqual([]);
  });
});

describe("pythonEntry", () => {
  test("a file with a __main__ guard wins over scripts", async () => {
    files["/p/pyproject.toml"] = `[project.scripts]\napp = "app:main"\n`;
    files["/p/run.py"] = `if __name__ == '__main__':\n    pass\n`;
    files["/p/lib.py"] = `def f(): pass\n`;
    expect(await pythonEntry("/p/run.py", "/p")).toEqual({ kind: "file", file: "/p/run.py" });
    expect(await pythonEntry("/p/lib.py", "/p")).toEqual({ kind: "script", name: "app", target: "app:main" });
    expect(await pythonEntry("/p/README.md", "/p")).toEqual({ kind: "script", name: "app", target: "app:main" });
  });
  test("no scripts: the python file itself, else none", async () => {
    files["/p/pyproject.toml"] = `[project]\n`;
    expect(await pythonEntry("/p/lib.py", "/p")).toEqual({ kind: "file", file: "/p/lib.py" });
    expect(await pythonEntry(null, "/p")).toEqual({ kind: "none" });
  });
});

describe("findPythonMain (#78)", () => {
  test("root main.py, else the first file with a __main__ guard", async () => {
    const guard = `if __name__ == "__main__":\n    main()\n`;
    files["/p/pyproject.toml"] = `[project]\n`;
    files["/p/test_main.py"] = guard;
    files["/p/.venv/lib/x.py"] = guard;
    files["/p/src/app/util.py"] = "def f(): pass\n";
    files["/p/src/app/main.py"] = guard;
    expect(await findPythonMain("/p")).toBe("/p/src/app/main.py");
    files["/p/main.py"] = "print(1)\n";
    expect(await findPythonMain("/p")).toBe("/p/main.py");
  });
  test("nothing runnable: null, and Run is disabled instead of 'uv run main.py'", async () => {
    files["/p/pyproject.toml"] = `[project]\n`;
    files["/p/src/lib.py"] = "def f(): pass\n";
    expect(await findPythonMain("/p")).toBeNull();
    expect((await detectProject(null, "/p"))?.run).toBeNull();
  });
  test("uv project without an open file runs the found entry", async () => {
    files["/p/pyproject.toml"] = `[project]\n`;
    files["/p/src/app/main.py"] = `if __name__ == '__main__':\n    pass\n`;
    expect((await detectProject(null, "/p"))?.run?.cmd).toBe("uv run src/app/main.py");
  });
});

describe("detectProject", () => {
  test("uv project: runs the file relative to the root", async () => {
    files["/w/py/pyproject.toml"] = `[project]\n`;
    files["/w/py/src/my app.py"] = "";
    const p = (await detectProject("/w/py/src/my app.py", "/w"))!;
    expect(p).toMatchObject({ kind: "uv", root: "/w/py", label: "uv", needs: ["uv"] });
    expect(p.run?.cmd).toBe("uv run 'src/my app.py'");
    expect(p.test?.cmd).toBe("uv run pytest");
  });

  test("walks up to the nearest marker", async () => {
    files["/w/package.json"] = JSON.stringify({ scripts: { dev: "vite", build: "vite build", test: "vitest" } });
    const p = (await detectProject("/w/src/deep/readme.md", "/w"))!;
    expect(p.kind).toBe("pnpm");
    expect(p.root).toBe("/w");
    expect(p.run).toMatchObject({ label: "pnpm dev", cmd: "pnpm run dev" });
    expect(p.build?.cmd).toBe("pnpm run build");
    expect(p.test?.cmd).toBe("pnpm test");
    expect(p.more.filter((a) => a.id.startsWith("script:")).map((a) => a.cmd)).toEqual(["pnpm run dev", "pnpm run build", "pnpm run test"]);
  });

  test("pnpm: plain JavaScript without a build script has no Build (#83)", async () => {
    files["/w/package.json"] = JSON.stringify({ scripts: { start: "node index.js", test: "node --test" } });
    const p = (await detectProject("/w/index.js", "/w"))!;
    expect(p.build).toBeNull();
    files["/w/package.json"] = JSON.stringify({ devDependencies: { typescript: "^5" } });
    expect((await detectProject("/w/index.js", "/w"))!.build?.cmd).toBe("pnpm exec tsc --noEmit");
  });

  test("pnpm: a TS file runs with tsx, no build script → typecheck", async () => {
    files["/w/package.json"] = "{}";
    files["/w/tsconfig.json"] = "{}";
    const p = (await detectProject("/w/src/index.ts", "/w"))!;
    // Without a local tsx: dlx, with esbuild's build allowed so pnpm doesn't ask interactively (#81).
    expect(p.run?.cmd).toBe("pnpm dlx --allow-build=esbuild tsx /w/src/index.ts");
    expect(p.build?.cmd).toBe("pnpm exec tsc --noEmit");
    expect(p.test).toBeNull();
  });

  test("pnpm: a TS file runs with the project's own tsx when installed (#81)", async () => {
    files["/w/package.json"] = JSON.stringify({ devDependencies: { tsx: "^4" } });
    files["/w/node_modules/.bin/tsx"] = "";
    const p = (await detectProject("/w/src/index.ts", "/w"))!;
    expect(p.run?.cmd).toBe("pnpm exec tsx /w/src/index.ts");
  });

  test("lone TS file runs tsx through dlx without the build prompt (#81)", async () => {
    const p = (await detectProject("/x/a.ts", null))!;
    expect(p.run?.cmd).toBe("pnpm dlx --allow-build=esbuild tsx /x/a.ts");
  });

  test("Cargo workspace: the outermost Cargo.toml wins", async () => {
    files["/w/Cargo.toml"] = "[workspace]";
    files["/w/crates/a/Cargo.toml"] = "[package]";
    const p = (await detectProject("/w/crates/a/src/main.rs", "/w"))!;
    expect(p).toMatchObject({ kind: "cargo", root: "/w" });
    expect(p.run).toMatchObject({ cmd: "cargo run -q", pre: "cargo build" });
  });

  test("Cargo crate inside another project type stays a Cargo project", async () => {
    files["/w/package.json"] = "{}";
    files["/w/native/Cargo.toml"] = "[package]";
    expect(await detectProject("/w/native/src/lib.rs", "/w")).toMatchObject({ kind: "cargo", root: "/w/native" });
  });

  test("does not look above the workspace", async () => {
    files["/pyproject.toml"] = "";
    files["/home/pyproject.toml"] = "";
    const p = await detectProject("/home/me/ws/notes.txt", "/home/me/ws");
    expect(p).toBeNull();
  });

  test("CMake: executable name from add_executable, configure as setup", async () => {
    files["/c/CMakeLists.txt"] = "project(x)\nadd_executable( hello src/main.cpp)\n";
    const p = (await detectProject("/c/src/main.cpp", "/c"))!;
    expect(p.kind).toBe("cmake");
    expect(p.run?.cmd).toBe("./build/hello");
    expect(p.run?.setup).toEqual({ unless: "build/CMakeCache.txt", cmd: "cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON" });
    expect(p.needs).toEqual(["cmake", "cc"]);
  });

  test("CMake: add_executable(${PROJECT_NAME}) runs the project() name, not the folder name", async () => {
    files["/work/c/CMakeLists.txt"] = "cmake_minimum_required(VERSION 3.20)\nproject(hello C)\nadd_executable(${PROJECT_NAME} main.c)\n";
    expect((await detectProject("/work/c/main.c", "/work/c"))!.run?.cmd).toBe("./build/hello");
  });

  test("CMake: a commented-out add_executable above the real one is ignored", async () => {
    files["/c/CMakeLists.txt"] = "project(x)\n# add_executable(old old.c)\nadd_executable(app main.c)\n";
    expect((await detectProject("/c/main.c", "/c"))!.run?.cmd).toBe("./build/app");
  });

  test("CMake: the folder-name fallback is quoted when it has spaces", async () => {
    files["/w/my project/CMakeLists.txt"] = "cmake_minimum_required(VERSION 3.20)\n";
    expect((await detectProject("/w/my project/main.c", "/w/my project"))!.run?.cmd).toBe("'./build/my project'");
  });

  test("Gradle with and without wrapper", async () => {
    files["/g/settings.gradle.kts"] = "";
    expect((await detectProject(null, "/g"))!).toMatchObject({ kind: "gradle", needs: ["jdk", "gradle"], build: { cmd: "gradle build" } });
    files["/g/gradlew"] = "";
    expect((await detectProject(null, "/g"))!).toMatchObject({ needs: ["jdk"], build: { cmd: "./gradlew build" } });
  });

  test("single files without a project", async () => {
    const py = (await detectProject("/x/a.py", null))!;
    expect(py).toMatchObject({ kind: "file", root: "/x", build: null });
    expect(py.run?.cmd).toBe("uv run /x/a.py");
    const c = (await detectProject("/x/main.c", null))!;
    expect(c.run?.cmd).toBe("/tmp/omega-main");
    expect(c.run?.pre).toBe("gcc -g -Wall /x/main.c -o /tmp/omega-main -lm");
    expect(c.build?.cmd).toBe(c.run?.pre);
  });

  test("unknown file type / nothing open → null", async () => {
    expect(await detectProject("/x/notes.txt", null)).toBeNull();
    expect(await detectProject(null, null)).toBeNull();
  });
});

describe("cmakeExecutable", () => {
  test("plain name", () => expect(cmakeExecutable("add_executable(hello main.c)")).toBe("hello"));
  test("${PROJECT_NAME} and ${CMAKE_PROJECT_NAME}", () => {
    expect(cmakeExecutable("project(demo VERSION 1.0 LANGUAGES CXX)\nadd_executable(${PROJECT_NAME} main.cpp)")).toBe("demo");
    expect(cmakeExecutable("PROJECT(demo)\nADD_EXECUTABLE(${CMAKE_PROJECT_NAME}_cli main.cpp)")).toBe("demo_cli");
  });
  test("set() variables", () => {
    expect(cmakeExecutable('project(p)\nset(APP "tool")\nadd_executable(${APP} main.c)')).toBe("tool");
  });
  test("line and bracket comments", () => {
    expect(cmakeExecutable("# add_executable(a a.c)\nadd_executable(b b.c) # add_executable(c)")).toBe("b");
    expect(cmakeExecutable("#[[\nadd_executable(a a.c)\n]]\nadd_executable(b b.c)")).toBe("b");
    expect(cmakeExecutable("#[==[ add_executable(a a.c) ]] ]==]\nadd_executable(b b.c)")).toBe("b");
    expect(cmakeExecutable('message("#not a comment")\nadd_executable(b b.c)')).toBe("b");
  });
  test("skips IMPORTED / ALIAS and unresolvable names, falls back to project()", () => {
    expect(cmakeExecutable("project(p)\nadd_executable(ext IMPORTED)\nadd_executable(real main.c)")).toBe("real");
    expect(cmakeExecutable("project(p)\nadd_executable(${UNKNOWN} main.c)")).toBe("p");
    expect(cmakeExecutable("cmake_minimum_required(VERSION 3.20)")).toBeNull();
  });
});

describe("TypeScript template (#80)", () => {
  test("allows esbuild's build script, so pnpm add succeeds and tsc --init runs", async () => {
    const plan = await TEMPLATES.find((t) => t.id === "typescript")!.create("demo");
    expect(plan.files?.["pnpm-workspace.yaml"]).toMatch(/allowBuilds:\n\s+esbuild: true/);
    expect(plan.files?.["pnpm-workspace.yaml"]).toMatch(/onlyBuiltDependencies:\n\s+- esbuild/);
    expect(plan.cmds.at(-1)).toMatch(/^pnpm exec tsc --init/);
  });
});

describe("Python template", () => {
  test("plain uv init (package layout), then sync inside the new folder", async () => {
    const tpl = TEMPLATES.find((t) => t.id === "python")!;
    const plan = await tpl.create("demo");
    expect(plan.inParent).toBe(true);
    expect(plan.cmds[0]).toMatch(/^uv init ['"]?demo['"]?$/);
    expect(plan.cmds.at(-1)).toBe("uv sync");
    expect(tpl.open).toContain("src/{name}/__init__.py");
  });
});

describe("template hello world follows the UI language (#82)", () => {
  test.each([["en", "Hello, world!"], ["de", "Hallo, Welt!"]] as const)("%s", async (locale, hello) => {
    const before = i18n.locale;
    i18n.locale = locale;
    try {
      for (const [id, file] of [["typescript", "src/index.ts"], ["javascript", "index.js"], ["c", "src/main.c"], ["cpp", "src/main.cpp"]]) {
        const plan = await TEMPLATES.find((t) => t.id === id)!.create("demo");
        expect(plan.files?.[file], id).toContain(`"${hello}`);
      }
    } finally {
      i18n.locale = before;
    }
  });
});

describe("project files can't put shell text into a run action", () => {
  test("package.json: script names with shell text or options aren't offered, others are quoted", async () => {
    files["/p/package.json"] = JSON.stringify({ scripts: { lint: "x", "test:unit": "x", "watch all": "x", "x; touch /tmp/pwned": "x", "$(id)": "x", "`id`": "x", "--registry=evil": "x", "{file}": "x", "a'b": "x", "a\nb": "x" } });
    const p = (await detectProject(null, "/p"))!;
    expect(p.more.filter((a) => a.id.startsWith("script:")).map((a) => a.cmd)).toEqual(["pnpm run lint", "pnpm run test:unit", "pnpm run 'watch all'"]);
  });

  test("uv: an entry point or file starting with a dash isn't read as an option", async () => {
    files["/p/pyproject.toml"] = `[project]\nname = "x"\n\n[project.scripts]\n"--with" = "m:f"\n`;
    expect((await detectProject(null, "/p"))?.run?.cmd).toBe("uv run -- --with");
    files["/p/pyproject.toml"] = `[project]\nname = "x"\n`;
    files["/p/-x.py"] = "print(1)";
    expect((await detectProject("/p/-x.py", "/p"))?.run?.cmd).toBe("uv run ./-x.py");
  });
});

describe("`%` can't reach cmd.exe through a uv entry", () => {
  test("[project.scripts] entries with % are dropped", async () => {
    files["/p/pyproject.toml"] = `[project.scripts]\n"%PATH%" = "m:f"\nbad = "%TEMP%:f"\ngood = "m:f"\n`;
    expect(await pyprojectScripts("/p")).toEqual([{ name: "good", target: "m:f" }]);
  });

  test("a file with % isn't run on Windows, and still is elsewhere", () => {
    const entry = { kind: "file" as const, file: "/p/100%.py" };
    expect(uvRunTarget(entry, "100%.py", true)).toBeNull();
    expect(uvRunTarget(entry, "100%.py", false)).toBe("100%.py");
  });
});

test("the actions that follow the open file say so", async () => {
  files = { "/p/pyproject.toml": "[project]\nname = 'x'\n", "/p/a.py": "print(1)\n", "/q/a.c": "int main(){}\n" };
  const uv = await detectProject("/p/a.py", "/p");
  expect(uv?.run?.usesFile).toBe(true);
  expect(uv?.build?.usesFile).toBeFalsy();
  const single = await detectProject("/q/a.c", "/q");
  expect(single?.run?.usesFile).toBe(true);
  expect(single?.build?.usesFile).toBe(true);
});
