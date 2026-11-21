import { beforeEach, describe, expect, test } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { versionArg, versionSettings } from "./versions";
import type { Project, ProjectKind } from "./projects";

let files: Record<string, string> = {};
let captured = "";
beforeEach(() => {
  files = {};
  captured = "";
  mockIPC((cmd, args) => {
    const a = args as { path?: string; content?: string };
    switch (cmd) {
      case "read_file":
        if (a.path! in files) return files[a.path!];
        throw new Error("not found");
      case "write_file":
        files[a.path!] = a.content!;
        return null;
      case "run_capture":
        return { code: 0, stdout: captured };
      default:
        return null;
    }
  });
});

const proj = (kind: ProjectKind, root = "/p") => ({ kind, root }) as Project;
const one = async (kind: ProjectKind, id?: string) => {
  const s = await versionSettings(proj(kind));
  return id ? s.find((x) => x.id === id)! : s[0];
};

describe("Python", () => {
  test(".python-version pin wins over requires-python", async () => {
    files["/p/.python-version"] = "3.12.4\n";
    files["/p/pyproject.toml"] = `[project]\nrequires-python = ">=3.10"\n`;
    expect(await one("uv")).toMatchObject({ current: "3.12.4", chip: "Python 3.12.4" });
    delete files["/p/.python-version"];
    expect(await one("uv")).toMatchObject({ current: ">=3.10", chip: "Python >=3.10" });
  });

  test("apply keeps requires-python compatible and returns the pin command", async () => {
    files["/p/pyproject.toml"] = `[project]\nrequires-python = ">=3.10"\n`;
    const s = await one("uv");
    expect(await s.apply("3.13")).toBe("uv python pin 3.13 && uv sync");
    expect(files["/p/pyproject.toml"]).toBe(`[project]\nrequires-python = ">=3.13"\n`);
  });

  test("options: CPython minors, newest first, with installed / pre-release tags", async () => {
    files["/p/.python-version"] = "3.12";
    const row = (version: string, minor: number, path: string | null, implementation = "cpython", variant = "default") =>
      ({ version, version_parts: { major: 3, minor }, path, implementation, variant });
    captured = JSON.stringify([
      row("3.14.0a1", 14, null),
      row("3.12.4", 12, "/usr/bin/python3.12"),
      row("3.13.1", 13, null),
      row("3.13.1", 13, null, "pypy"),
      row("3.13.1", 13, null, "cpython", "freethreaded"),
      row("3.9.0", 9, null),
    ]);
    const opts = await (await one("uv")).options();
    expect(opts.map((o) => o.value)).toEqual(["3.14", "3.13", "3.12", "3.9"]);
    expect(opts[0].tag).toBeTruthy(); // pre-release
    expect(opts[1].tag).toBeUndefined();
    expect(opts[1].detail).toBeTruthy(); // download
    expect(opts[2].tag).toBeTruthy(); // current (overrides "installed")
  });
});

describe("Node", () => {
  test("devEngines.runtime, then engines.node", async () => {
    files["/p/package.json"] = JSON.stringify({ devEngines: { runtime: { name: "node", version: "22.3.0" } } });
    expect(await one("pnpm")).toMatchObject({ current: "22.3.0", chip: "Node 22.3" });
    files["/p/package.json"] = JSON.stringify({ devEngines: { runtime: [{ name: "deno" }, { name: "node", version: "^20" }] } });
    expect((await one("pnpm")).current).toBe("^20");
    files["/p/package.json"] = JSON.stringify({ engines: { node: ">=18" } });
    expect((await one("pnpm")).chip).toBe("Node 18");
    files["/p/package.json"] = "{}";
    expect((await one("pnpm")).current).toBeNull();
  });
});

describe("Rust", () => {
  test("toolchain channel and edition", async () => {
    files["/p/rust-toolchain.toml"] = `[toolchain]\nchannel = "1.80.0"\n`;
    files["/p/Cargo.toml"] = `[package]\nname = "x"\nedition = "2021"\n`;
    const s = await versionSettings(proj("cargo"));
    expect(s.map((x) => [x.id, x.current, x.chip])).toEqual([
      ["rust-toolchain", "1.80.0", "Rust 1.80.0"],
      ["rust-edition", "2021", "Edition 2021"],
    ]);
  });

  test("legacy rust-toolchain file; no edition → no edition setting", async () => {
    files["/p/rust-toolchain"] = "nightly\n";
    files["/p/Cargo.toml"] = `[workspace]\n`;
    const s = await versionSettings(proj("cargo"));
    expect(s.map((x) => [x.id, x.current])).toEqual([["rust-toolchain", "nightly"]]);
  });

  test("apply writes rust-toolchain.toml and the edition", async () => {
    files["/p/Cargo.toml"] = `[package]\nedition = "2021"\n`;
    const [tc, ed] = await versionSettings(proj("cargo"));
    expect(tc.chip).toBe("Rust stable");
    expect(await tc.apply("beta")).toBe("rustup toolchain install beta && cargo build");
    expect(files["/p/rust-toolchain.toml"]).toBe(`[toolchain]\nchannel = "beta"\n`);
    await ed.apply("2024");
    expect(files["/p/Cargo.toml"]).toBe(`[package]\nedition = "2024"\n`);
  });

  test("toolchain options strip the host triple and tag installed ones", async () => {
    captured = "stable-x86_64-unknown-linux-gnu (default)\n1.75.0-x86_64-unknown-linux-gnu\n";
    const opts = await (await one("cargo")).options();
    expect(opts.map((o) => o.value)).toEqual(["stable", "beta", "nightly", "1.75.0"]);
    expect(opts[0].tag).toBeTruthy();
    expect(opts[1].tag).toBeUndefined();
  });
});

describe("C / C++ (CMake)", () => {
  test("standard + extensions → c17 / gnu++20", async () => {
    files["/p/CMakeLists.txt"] = `project(x C CXX)\nset(CMAKE_C_STANDARD 17)\nset(CMAKE_C_EXTENSIONS OFF)\nset(CMAKE_CXX_STANDARD 20)\n`;
    const s = await versionSettings(proj("cmake"));
    expect(s.map((x) => [x.id, x.current])).toEqual([["c-std", "c17"], ["cxx-std", "gnu++20"]]);
  });

  test("only the languages listed in project()", async () => {
    files["/p/CMakeLists.txt"] = `project(x CXX)\n`;
    const s = await versionSettings(proj("cmake"));
    expect(s.map((x) => x.id)).toEqual(["cxx-std"]);
    expect(s[0].current).toBeNull();
    files["/p/CMakeLists.txt"] = `project(x)\n`;
    expect((await versionSettings(proj("cmake"))).map((x) => x.id)).toEqual(["c-std", "cxx-std"]);
  });

  test("apply inserts standard, REQUIRED and EXTENSIONS after project()", async () => {
    files["/p/CMakeLists.txt"] = `cmake_minimum_required(VERSION 3.20)\nproject(x CXX)\nadd_executable(x main.cpp)\n`;
    const s = await one("cmake", "cxx-std");
    await s.apply("c++23");
    expect(files["/p/CMakeLists.txt"]).toBe(
      `cmake_minimum_required(VERSION 3.20)\nproject(x CXX)\n\nset(CMAKE_CXX_STANDARD 23)\nset(CMAKE_CXX_STANDARD_REQUIRED ON)\nset(CMAKE_CXX_EXTENSIONS OFF)\nadd_executable(x main.cpp)\n`,
    );
  });

  test("apply updates existing lines; gnu89 = 90; bare number keeps extension mode", async () => {
    files["/p/CMakeLists.txt"] = `project(x C)\nset(CMAKE_C_STANDARD 11)\nset(CMAKE_C_EXTENSIONS OFF)\n`;
    const s = await one("cmake", "c-std");
    await s.apply("gnu89");
    expect(files["/p/CMakeLists.txt"]).toBe(`project(x C)\nset(CMAKE_C_STANDARD 90)\nset(CMAKE_C_EXTENSIONS ON)\n`);
    files["/p/CMakeLists.txt"] = `project(x C)\nset(CMAKE_C_STANDARD 11)\nset(CMAKE_C_EXTENSIONS OFF)\n`;
    await (await one("cmake", "c-std")).apply("17");
    expect(files["/p/CMakeLists.txt"]).toContain("set(CMAKE_C_STANDARD 17)\nset(CMAKE_C_EXTENSIONS OFF)");
  });

  test("apply rejects garbage", async () => {
    files["/p/CMakeLists.txt"] = `project(x C)\n`;
    await expect((await one("cmake", "c-std")).apply("latest")).rejects.toThrow();
  });
});

describe("Java (Gradle)", () => {
  test("finds the toolchain in app/build.gradle.kts", async () => {
    files["/p/build.gradle.kts"] = `plugins {}\n`;
    files["/p/app/build.gradle.kts"] = `java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n`;
    expect(await one("gradle")).toMatchObject({ current: "21", chip: "Java 21" });
  });

  test("apply appends a toolchain block when none exists", async () => {
    files["/p/build.gradle"] = `plugins {}\n`;
    const s = await one("gradle");
    expect(s.current).toBeNull();
    await s.apply("17");
    expect(files["/p/build.gradle"]).toContain("languageVersion = JavaLanguageVersion.of(17)");
  });

  test("no build file → no setting; other kinds → []", async () => {
    expect(await versionSettings(proj("gradle"))).toEqual([]);
    expect(await versionSettings(proj("file"))).toEqual([]);
    expect(await versionSettings(null)).toEqual([]);
  });
});

describe("versionArg: a version read from a project file can't inject", () => {
  test.each(["3.12; touch /tmp/pwned", "$(id)", "`id`", "--force", "-y", "a b", "a|b", "a&b", "a'b", 'a"b', "a\\b", "a\nb", "%PATH%", ""])("refuses %j", (v) => {
    expect(() => versionArg(v)).toThrow();
  });
  test.each([["3.12", "3.12"], ["22", "22"], ["stable", "stable"], ["nightly-2026-01-01", "nightly-2026-01-01"], ["1.80.0", "1.80.0"], ["pypy@3.10", "pypy@3.10"], [">=3.12", "'>=3.12'"], ["^22", "'^22'"]])("%s", (v, word) => {
    expect(versionArg(v)).toBe(word);
  });
});
