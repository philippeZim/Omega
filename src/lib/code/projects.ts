/** Project detection and the recommended tool per language: cargo, uv, pnpm, CMake, Gradle. */
import { fsApi, basename, dirname, joinPath } from "../api";
import { shellQuote as q } from "../terminal.svelte";
import { langFor, type LangId } from "./languages";

export type ProjectKind = "cargo" | "uv" | "pnpm" | "cmake" | "gradle" | "file";

export interface Action {
  id: string;
  label: string;
  /** Shell command run in the "Ausführen" terminal (cwd = project root). */
  cmd?: string;
  /** Needs a user-provided argument (e.g. package name); `{}` is replaced. */
  ask?: string;
  shortcut?: string;
}

export interface Project {
  kind: ProjectKind;
  root: string;
  label: string;
  run: Action | null;
  build: Action | null;
  test: Action | null;
  more: Action[];
}

const MARKERS: [string, ProjectKind][] = [
  ["Cargo.toml", "cargo"],
  ["pyproject.toml", "uv"],
  ["CMakeLists.txt", "cmake"],
  ["settings.gradle.kts", "gradle"],
  ["settings.gradle", "gradle"],
  ["build.gradle.kts", "gradle"],
  ["build.gradle", "gradle"],
  ["package.json", "pnpm"],
];

async function findProject(file: string | null, workspace: string | null): Promise<{ kind: ProjectKind; root: string } | null> {
  let dir = file ? dirname(file) : workspace;
  const stop = workspace ? dirname(workspace) : "/";
  let found: { kind: ProjectKind; root: string } | null = null;
  while (dir && dir !== stop && dir !== "/") {
    for (const [m, kind] of MARKERS) {
      if (await fsApi.exists(joinPath(dir, m))) {
        // Cargo workspaces: keep walking to the outermost Cargo.toml.
        if (kind === "cargo") found = { kind, root: dir };
        else return found ?? { kind, root: dir };
        break;
      }
    }
    dir = dirname(dir);
  }
  return found;
}

/** First `[project.scripts]` entry of a pyproject.toml: name = "module:function". */
export async function pyprojectScripts(root: string): Promise<{ name: string; target: string }[]> {
  try {
    const toml = await fsApi.readFile(joinPath(root, "pyproject.toml"));
    const sec = /^\[project\.scripts\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml)?.[1] ?? "";
    return [...sec.matchAll(/^\s*["']?([\w.-]+)["']?\s*=\s*["']([^"']+)["']/gm)].map((m) => ({ name: m[1], target: m[2] }));
  } catch {
    return [];
  }
}

/**
 * What "run this" means for Python: a file with a __main__ guard runs as a script; otherwise a
 * package project's [project.scripts] entry point (uv 0.13 package layout); otherwise the file.
 */
export async function pythonEntry(file: string | null, root: string): Promise<{ kind: "file"; file: string } | { kind: "script"; name: string; target: string } | { kind: "none" }> {
  const isPy = file && langFor(file)?.id === "python";
  if (isPy) {
    const text = await fsApi.readFile(file).catch(() => "");
    if (/if\s+__name__\s*==\s*["']__main__["']/.test(text)) return { kind: "file", file };
  }
  const scripts = await pyprojectScripts(root);
  if (scripts.length) return { kind: "script", ...scripts[0] };
  if (isPy) return { kind: "file", file };
  return { kind: "none" };
}

async function cmakeTarget(root: string): Promise<string> {
  try {
    const txt = await fsApi.readFile(joinPath(root, "CMakeLists.txt"));
    return /add_executable\s*\(\s*([\w.-]+)/.exec(txt)?.[1] ?? basename(root);
  } catch {
    return basename(root);
  }
}

async function packageScripts(root: string): Promise<string[]> {
  try {
    return Object.keys(JSON.parse(await fsApi.readFile(joinPath(root, "package.json"))).scripts ?? {});
  } catch {
    return [];
  }
}

const RUN = "Shift+F10", BUILD = "Strg+F9";

export async function detectProject(file: string | null, workspace: string | null): Promise<Project | null> {
  const p = await findProject(file, workspace);
  const rel = (f: string, root: string) => (f.startsWith(root + "/") ? f.slice(root.length + 1) : f);

  if (p?.kind === "cargo")
    return {
      ...p,
      label: "cargo",
      run: { id: "run", label: "Ausführen", cmd: "cargo run", shortcut: RUN },
      build: { id: "build", label: "Bauen", cmd: "cargo build", shortcut: BUILD },
      test: { id: "test", label: "Testen", cmd: "cargo test" },
      more: [
        { id: "check", label: "cargo check", cmd: "cargo check" },
        { id: "clippy", label: "cargo clippy (Linter)", cmd: "cargo clippy" },
        { id: "fmt", label: "cargo fmt (Formatieren)", cmd: "cargo fmt" },
        { id: "release", label: "Release bauen", cmd: "cargo build --release" },
        { id: "add", label: "Abhängigkeit hinzufügen…", ask: "Crate-Name (z.B. serde)", cmd: "cargo add {}" },
        { id: "update", label: "cargo update", cmd: "cargo update" },
        { id: "clean", label: "cargo clean", cmd: "cargo clean" },
      ],
    };

  if (p?.kind === "uv") {
    const entry = await pythonEntry(file, p.root);
    const target = entry.kind === "script" ? q(entry.name) : entry.kind === "file" ? q(rel(entry.file, p.root)) : "main.py";
    return {
      ...p,
      label: "uv",
      run: { id: "run", label: "Ausführen", cmd: `uv run ${target}`, shortcut: RUN },
      build: { id: "build", label: "Paket bauen", cmd: "uv build", shortcut: BUILD },
      test: { id: "test", label: "Testen", cmd: "uv run pytest" },
      more: [
        { id: "sync", label: "uv sync (Umgebung aktualisieren)", cmd: "uv sync" },
        { id: "add", label: "Abhängigkeit hinzufügen…", ask: "Paket (z.B. requests)", cmd: "uv add {}" },
        { id: "adddev", label: "Dev-Abhängigkeit hinzufügen…", ask: "Paket (z.B. pytest)", cmd: "uv add --dev {}" },
        { id: "remove", label: "Abhängigkeit entfernen…", ask: "Paket", cmd: "uv remove {}" },
        { id: "fmt", label: "ruff format (Formatieren)", cmd: "uvx ruff format" },
        { id: "lint", label: "ruff check (Linter)", cmd: "uvx ruff check" },
        { id: "lock", label: "uv lock", cmd: "uv lock" },
      ],
    };
  }

  if (p?.kind === "pnpm") {
    const scripts = await packageScripts(p.root);
    const lang = file ? langFor(file)?.id : null;
    const fileRun = file && (lang === "typescript" ? `pnpm dlx tsx ${q(file)}` : lang === "javascript" ? `node ${q(file)}` : null);
    const runScript = ["dev", "start"].find((s) => scripts.includes(s));
    return {
      ...p,
      label: "pnpm",
      run: fileRun
        ? { id: "run", label: "Ausführen", cmd: fileRun, shortcut: RUN }
        : runScript
          ? { id: "run", label: `pnpm ${runScript}`, cmd: `pnpm run ${runScript}`, shortcut: RUN }
          : null,
      build: scripts.includes("build") ? { id: "build", label: "Bauen", cmd: "pnpm run build", shortcut: BUILD } : { id: "build", label: "Typprüfung", cmd: "pnpm exec tsc --noEmit", shortcut: BUILD },
      test: scripts.includes("test") ? { id: "test", label: "Testen", cmd: "pnpm test" } : null,
      more: [
        ...scripts.map((s) => ({ id: `script:${s}`, label: `pnpm run ${s}`, cmd: `pnpm run ${s}` })),
        { id: "install", label: "pnpm install", cmd: "pnpm install" },
        { id: "add", label: "Abhängigkeit hinzufügen…", ask: "Paket (z.B. zod)", cmd: "pnpm add {}" },
        { id: "adddev", label: "Dev-Abhängigkeit hinzufügen…", ask: "Paket (z.B. vitest)", cmd: "pnpm add -D {}" },
        { id: "remove", label: "Abhängigkeit entfernen…", ask: "Paket", cmd: "pnpm remove {}" },
      ],
    };
  }

  if (p?.kind === "cmake") {
    const target = await cmakeTarget(p.root);
    const configure = "cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && ln -sf build/compile_commands.json .";
    const ensure = `{ [ -f build/CMakeCache.txt ] || ${configure}; }`;
    return {
      ...p,
      label: "CMake",
      run: { id: "run", label: "Ausführen", cmd: `${ensure} && cmake --build build && ./build/${target}`, shortcut: RUN },
      build: { id: "build", label: "Bauen", cmd: `${ensure} && cmake --build build`, shortcut: BUILD },
      test: { id: "test", label: "Testen", cmd: `${ensure} && cmake --build build && ctest --test-dir build --output-on-failure` },
      more: [
        { id: "configure", label: "Konfigurieren (Debug)", cmd: configure },
        { id: "release", label: "Release bauen", cmd: "cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release && cmake --build build-release" },
        { id: "clean", label: "Clean", cmd: "cmake --build build --target clean" },
        { id: "reset", label: "Build-Ordner löschen", cmd: "rm -rf build" },
      ],
    };
  }

  if (p?.kind === "gradle") {
    const g = (await fsApi.exists(joinPath(p.root, "gradlew"))) ? "./gradlew" : "gradle";
    return {
      ...p,
      label: "Gradle",
      run: { id: "run", label: "Ausführen", cmd: `${g} run --console=plain`, shortcut: RUN },
      build: { id: "build", label: "Bauen", cmd: `${g} build`, shortcut: BUILD },
      test: { id: "test", label: "Testen", cmd: `${g} test` },
      more: [
        { id: "clean", label: "gradle clean", cmd: `${g} clean` },
        { id: "deps", label: "Abhängigkeiten anzeigen", cmd: `${g} dependencies --configuration runtimeClasspath` },
        { id: "wrapper", label: "Gradle-Wrapper erzeugen", cmd: "gradle wrapper" },
        { id: "jar", label: "JAR bauen", cmd: `${g} jar` },
      ],
    };
  }

  // No project: run the single file with the language's default tool.
  if (!file) return null;
  const lang = langFor(file)?.id;
  const cmd = singleFileRun(lang, file);
  if (!cmd) return null;
  return {
    kind: "file",
    root: dirname(file),
    label: "Datei",
    run: { id: "run", label: "Ausführen", cmd, shortcut: RUN },
    build: null,
    test: null,
    more: [],
  };
}

function singleFileRun(lang: LangId | undefined, file: string): string | null {
  const f = q(file);
  const out = q(`/tmp/studio-${basename(file).replace(/\.\w+$/, "")}`);
  switch (lang) {
    case "python": return `uv run ${f}`;
    case "c": return `gcc -g -Wall ${f} -o ${out} -lm && ${out}`;
    case "cpp": return `g++ -g -Wall -std=c++20 ${f} -o ${out} && ${out}`;
    case "java": return `java ${f}`;
    case "javascript": return `node ${f}`;
    case "typescript": return `pnpm dlx tsx ${f}`;
    case "rust": return `rustc -g ${f} -o ${out} && ${out}`;
    default: return null;
  }
}

// ---------------------------------------------------------------- new projects

export interface Template {
  id: string;
  label: string;
  tool: string;
  /** Builds the shell command creating `name` inside `parent`; returns [command, preferred file to open]. */
  create: (parent: string, name: string) => [string, string];
  /** File whose appearance means the project exists (relative to the project dir). */
  marker: string;
  /** Files to open afterwards, first existing wins (relative; {name} = project name). */
  open: string[];
}

const cmakeFiles = (name: string, cxx: boolean) => {
  const ext = cxx ? "cpp" : "c";
  const lists = `cmake_minimum_required(VERSION 3.20)\\nproject(${name} ${cxx ? "CXX" : "C"})\\n\\nset(CMAKE_${cxx ? "CXX" : "C"}_STANDARD ${cxx ? 20 : 17})\\nset(CMAKE_EXPORT_COMPILE_COMMANDS ON)\\n\\nadd_executable(${name} src/main.${ext})\\n`;
  const main = cxx
    ? `#include <iostream>\\n\\nint main() {\\n    std::cout << "Hallo, Welt!" << std::endl;\\n    return 0;\\n}\\n`
    : `#include <stdio.h>\\n\\nint main(void) {\\n    printf("Hallo, Welt!\\\\n");\\n    return 0;\\n}\\n`;
  return `mkdir -p src && printf '${lists}' > CMakeLists.txt && printf '${main.replace(/'/g, "'\\''")}' > src/main.${ext} && printf 'build/\\ncompile_commands.json\\n' > .gitignore && git init -q && cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && ln -sf build/compile_commands.json .`;
};

export const TEMPLATES: Template[] = [
  { id: "rust", label: "Rust", tool: "cargo new", marker: "Cargo.toml", open: ["src/main.rs"], create: (p, n) => [`cd ${q(p)} && cargo new ${q(n)} && cd ${q(n)}`, joinPath(joinPath(p, n), "src/main.rs")] },
  { id: "python", label: "Python", tool: "uv init", marker: "pyproject.toml", open: ["main.py", "src/{name}/__init__.py", "hello.py"], create: (p, n) => [`cd ${q(p)} && uv init --app --no-package ${q(n)} && cd ${q(n)} && uv sync`, joinPath(joinPath(p, n), "main.py")] },
  {
    id: "typescript",
    label: "TypeScript",
    tool: "pnpm + tsx",
    marker: "package.json",
    open: ["src/index.ts"],
    create: (p, n) => [
      `mkdir -p ${q(joinPath(p, n))}/src && cd ${q(joinPath(p, n))} && pnpm init && pnpm add -D typescript tsx @types/node && pnpm exec tsc --init --target es2022 --module nodenext --rootDir src --outDir dist && printf 'console.log("Hallo, Welt!");\\n' > src/index.ts && npm pkg set scripts.dev="tsx watch src/index.ts" scripts.start="tsx src/index.ts" scripts.build="tsc" && printf 'node_modules/\\ndist/\\n' > .gitignore && git init -q`,
      joinPath(joinPath(p, n), "src/index.ts"),
    ],
  },
  {
    id: "javascript",
    label: "JavaScript",
    tool: "pnpm",
    marker: "package.json",
    open: ["index.js"],
    create: (p, n) => [
      `mkdir -p ${q(joinPath(p, n))} && cd ${q(joinPath(p, n))} && pnpm init && npm pkg set type=module scripts.start="node index.js" && printf 'console.log("Hallo, Welt!");\\n' > index.js && printf 'node_modules/\\n' > .gitignore && git init -q`,
      joinPath(joinPath(p, n), "index.js"),
    ],
  },
  { id: "cpp", label: "C++", tool: "CMake", marker: "CMakeLists.txt", open: ["src/main.cpp"], create: (p, n) => [`mkdir -p ${q(joinPath(p, n))} && cd ${q(joinPath(p, n))} && ${cmakeFiles(n, true)}`, joinPath(joinPath(p, n), "src/main.cpp")] },
  { id: "c", label: "C", tool: "CMake", marker: "CMakeLists.txt", open: ["src/main.c"], create: (p, n) => [`mkdir -p ${q(joinPath(p, n))} && cd ${q(joinPath(p, n))} && ${cmakeFiles(n, false)}`, joinPath(joinPath(p, n), "src/main.c")] },
  {
    id: "java",
    label: "Java",
    tool: "Gradle",
    marker: "settings.gradle.kts",
    open: ["app/src/main/java/app/App.java"],
    create: (p, n) => [
      `mkdir -p ${q(joinPath(p, n))} && cd ${q(joinPath(p, n))} && gradle init --type java-application --dsl kotlin --test-framework junit-jupiter --package app --project-name ${q(n)} --no-split-project --java-version 21 --use-defaults --no-incubating`,
      joinPath(joinPath(p, n), "app/src/main/java/app/App.java"),
    ],
  },
];
