import { beforeEach, describe, expect, test } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { detectProject, pyprojectScripts, pythonEntry } from "./projects";

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

  test("pnpm: a TS file runs with tsx, no build script → typecheck", async () => {
    files["/w/package.json"] = "{}";
    const p = (await detectProject("/w/src/index.ts", "/w"))!;
    expect(p.run?.cmd).toBe("pnpm dlx tsx /w/src/index.ts");
    expect(p.build?.cmd).toBe("pnpm exec tsc --noEmit");
    expect(p.test).toBeNull();
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
