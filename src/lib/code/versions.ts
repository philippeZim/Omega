/**
 * Per-project language/runtime versions, changeable at any time from the run bar.
 *
 * Every setting is stored in the project itself (so it travels with the repo) and uses the
 * ecosystem's own mechanism, which downloads missing versions on demand:
 *   Python (uv)      .python-version via `uv python pin` (+ requires-python)
 *   Node (pnpm)      devEngines.runtime via `pnpm runtime set node`
 *   Rust (cargo)     rust-toolchain.toml (toolchain) and `edition` in Cargo.toml
 *   C / C++ (CMake)  CMAKE_C_STANDARD / CMAKE_CXX_STANDARD in CMakeLists.txt
 *   Java (Gradle)    Java toolchain `JavaLanguageVersion.of(N)` (Gradle provisions the JDK)
 */
import { invoke } from "@tauri-apps/api/core";
import { fsApi, joinPath } from "../api";
import { q } from "../platform";
import { t, type Key } from "../i18n/index.svelte";
import type { Project } from "./projects";
import type { Suggestion } from "./packages";

export interface VersionSetting {
  id: string;
  label: string;
  /** Current value, or null when the project doesn't pin one (system default). */
  current: string | null;
  /** Short form for the run-bar chip, e.g. "Python 3.12", "C++20". */
  chip: string;
  options: () => Promise<Suggestion[]>;
  /** Writes the new value; may return a command to run in the terminal (downloads, sync). */
  apply: (v: string) => Promise<string | void>;
  /** Shown after applying when nothing runs in the terminal. */
  note?: Key;
}

const read = (p: string) => fsApi.readFile(p).catch(() => null);

/**
 * A version as one shell word. The offered values include the one read from the project's files,
 * so it can't go into the command as it is.
 */
export function versionArg(v: string): string {
  if (v.length > 100 || !/^[A-Za-z0-9<>=~^!][A-Za-z0-9._+@~^=<>!,*/-]*$/.test(v)) throw new Error(t("code.ver.badVersion", { value: v.slice(0, 40) }));
  return q(v);
}

const capture = (cmd: string, args: string[], cwd: string) =>
  invoke<{ code: number; stdout: string }>("run_capture", { cmd, args, cwd }).catch(() => ({ code: -1, stdout: "" }));

/** Marks the current value in an option list (and puts it first if it isn't listed). */
function markCurrent(opts: Suggestion[], current: string | null): Suggestion[] {
  if (!current) return opts;
  const i = opts.findIndex((o) => o.value === current);
  if (i < 0) return [{ value: current, tag: t("code.ver.current") }, ...opts];
  return opts.map((o, j) => (j === i ? { ...o, tag: t("code.ver.current") } : o));
}

// ------------------------------------------------------------------ Python (uv)

async function python(root: string): Promise<VersionSetting> {
  const pin = (await read(joinPath(root, ".python-version")))?.trim().split(/\s+/)[0] || null;
  const pyproject = await read(joinPath(root, "pyproject.toml"));
  const req = pyproject?.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  return {
    id: "python",
    label: "Python",
    current: pin ?? req,
    chip: `Python ${pin ?? req ?? t("code.ver.system")}`,
    async options() {
      const r = await capture("uv", ["python", "list", "--output-format", "json"], root);
      let rows: { version: string; version_parts: { major: number; minor: number }; path: string | null; implementation: string; variant: string }[] = [];
      try {
        rows = JSON.parse(r.stdout);
      } catch {}
      const byMinor = new Map<string, { installed: boolean; pre: boolean }>();
      for (const x of rows) {
        if (x.implementation !== "cpython" || x.variant !== "default") continue;
        const k = `${x.version_parts.major}.${x.version_parts.minor}`;
        const cur = byMinor.get(k) ?? { installed: false, pre: true };
        cur.installed ||= !!x.path;
        cur.pre &&= /[a-z]/i.test(x.version); // only pre-releases known for this minor
        byMinor.set(k, cur);
      }
      const keys = [...byMinor.keys()].sort((a, b) => Number(b.split(".")[1]) - Number(a.split(".")[1]));
      const opts = keys.map((k) => {
        const v = byMinor.get(k)!;
        return { value: k, tag: v.pre ? t("code.ver.prerelease") : v.installed ? t("code.pkg.installed") : undefined, detail: v.installed || v.pre ? undefined : t("code.ver.download") };
      });
      return markCurrent(opts, pin);
    },
    async apply(v) {
      const arg = versionArg(v);
      // Keep requires-python compatible, otherwise `uv sync` refuses the pinned interpreter.
      if (pyproject && req) {
        const minor = v.match(/^(\d+\.\d+)/)?.[1];
        if (minor) await fsApi.writeFile(joinPath(root, "pyproject.toml"), pyproject.replace(/^(\s*requires-python\s*=\s*)["'][^"']*["']/m, `$1">=${minor}"`));
      }
      return `uv python pin ${arg} && uv sync`;
    },
  };
}

// ------------------------------------------------------------------ Node (pnpm)

async function node(root: string): Promise<VersionSetting> {
  let current: string | null = null;
  try {
    const pkg = JSON.parse((await read(joinPath(root, "package.json"))) ?? "{}");
    const rt = [pkg.devEngines?.runtime, pkg.engines?.runtime].flat().find((x) => x?.name === "node");
    current = rt?.version ?? pkg.engines?.node ?? null;
  } catch {}
  return {
    id: "node",
    label: "Node.js",
    current,
    chip: `Node ${current?.match(/\d+(\.\d+)?/)?.[0] ?? t("code.ver.system")}`,
    async options() {
      let opts: Suggestion[] = [];
      try {
        const list = (await (await fetch("https://nodejs.org/dist/index.json")).json()) as { version: string; lts: string | false }[];
        const seen = new Set<string>();
        for (const r of list) {
          const major = r.version.replace(/^v/, "").split(".")[0];
          if (seen.has(major) || Number(major) < 18) continue;
          seen.add(major);
          opts.push({ value: major, detail: r.version, tag: r.lts ? "LTS" : undefined });
        }
      } catch {
        opts = ["24", "22", "20"].map((value) => ({ value, tag: "LTS" }));
      }
      const major = current?.match(/\d+/)?.[0] ?? null;
      return markCurrent(opts, current && opts.some((o) => o.value === major) ? major : current);
    },
    apply: async (v) => `pnpm runtime set node ${versionArg(v)} -y && pnpm install`,
  };
}

// ------------------------------------------------------------------ Rust (cargo)

async function rust(root: string): Promise<VersionSetting[]> {
  const tomlPath = joinPath(root, "rust-toolchain.toml");
  const toml = await read(tomlPath);
  const legacy = toml ? null : (await read(joinPath(root, "rust-toolchain")))?.trim() || null;
  const channel = toml?.match(/^\s*channel\s*=\s*["']([^"']+)["']/m)?.[1] ?? legacy;
  const cargoPath = joinPath(root, "Cargo.toml");
  const cargo = await read(cargoPath);
  const edition = cargo?.match(/^\s*edition\s*=\s*["'](\d+)["']/m)?.[1] ?? null;
  return [
    {
      id: "rust-toolchain",
      label: t("code.ver.rustToolchain"),
      current: channel,
      chip: `Rust ${channel ?? "stable"}`,
      async options() {
        const r = await capture("rustup", ["toolchain", "list"], root);
        const installed = r.stdout.split("\n").map((l) => l.split(/\s/)[0].replace(/-(x86_64|aarch64|i686|arm)[\w-]*$/, "")).filter(Boolean);
        const base: Suggestion[] = [
          { value: "stable", detail: t("code.ver.rustStable") },
          { value: "beta", detail: t("code.ver.rustBeta") },
          { value: "nightly", detail: t("code.ver.rustNightly") },
        ];
        for (const n of installed) if (!base.some((b) => b.value === n)) base.push({ value: n });
        return markCurrent(base.map((b) => (installed.includes(b.value) && !b.tag ? { ...b, tag: t("code.pkg.installed") } : b)), channel);
      },
      async apply(v) {
        const arg = versionArg(v);
        const body = toml
          ? toml.replace(/^(\s*channel\s*=\s*)["'][^"']*["']/m, `$1"${v}"`)
          : `[toolchain]\nchannel = "${v}"\n`;
        await fsApi.writeFile(tomlPath, /channel\s*=/.test(body) ? body : `${body.trimEnd()}\nchannel = "${v}"\n`);
        return `rustup toolchain install ${arg} && cargo build`;
      },
    },
    ...(cargo && edition
      ? [{
          id: "rust-edition",
          label: t("code.ver.rustEdition"),
          current: edition,
          chip: `Edition ${edition}`,
          options: async () => markCurrent(["2024", "2021", "2018", "2015"].map((value) => ({ value })), edition),
          async apply(v: string) {
            const now = (await read(cargoPath)) ?? cargo;
            await fsApi.writeFile(cargoPath, now.replace(/^(\s*edition\s*=\s*)["']\d+["']/m, `$1"${v}"`));
          },
          note: "code.ver.appliedNextBuild" as Key,
        }]
      : []),
  ];
}

// ------------------------------------------------------------------ C / C++ (CMake)

async function cmake(root: string): Promise<VersionSetting[]> {
  const path = joinPath(root, "CMakeLists.txt");
  const text = (await read(path)) ?? "";
  const proj = text.match(/^\s*project\s*\(([^)]*)\)/im)?.[1] ?? "";
  const langsListed = /\b(C|CXX)\b/.test(proj.replace(/^\s*\S+/, ""));
  const std = (lang: "C" | "CXX") => text.match(new RegExp(`set\\s*\\(\\s*CMAKE_${lang}_STANDARD\\s+(\\d+)`, "i"))?.[1] ?? null;
  const uses = (lang: "C" | "CXX") => std(lang) !== null || !langsListed || new RegExp(`\\b${lang}\\b`).test(proj.replace(/^\s*\S+/, ""));

  // CMAKE_<LANG>_EXTENSIONS defaults to ON, so a bare standard means -std=gnuNN / gnu++NN.
  const ext = (lang: "C" | "CXX") => !/^(off|false|no|0|n)$/i.test(text.match(new RegExp(`set\\s*\\(\\s*CMAKE_${lang}_EXTENSIONS\\s+(\\w+)`, "i"))?.[1] ?? "ON");
  /** Values mirror the compiler flag: c17 / gnu17, c++20 / gnu++20. */
  const flag = (lang: "C" | "CXX", n: string, gnu: boolean) => `${gnu ? "gnu" : "c"}${lang === "CXX" ? "++" : ""}${n}`;

  const setting = (lang: "C" | "CXX"): VersionSetting => {
    const n = std(lang);
    const cur = n ? flag(lang, n, ext(lang)) : null;
    return {
      id: lang === "C" ? "c-std" : "cxx-std",
      label: lang === "C" ? t("code.ver.cStd") : t("code.ver.cxxStd"),
      current: cur,
      chip: cur ?? `${lang === "C" ? "C" : "C++"} ${t("code.ver.default")}`,
      options: async () =>
        markCurrent(
          (lang === "C" ? ["23", "17", "11", "99", "90"] : ["26", "23", "20", "17", "14", "11"]).flatMap((v) => {
            const alias = v === "90" ? " (C89)" : "";
            return [
              { value: flag(lang, v, false), detail: t("code.ver.isoStrict") + alias },
              { value: flag(lang, v, true), detail: t("code.ver.gnuExt") + alias },
            ];
          }),
          cur,
        ),
      async apply(input) {
        // Accept "gnu89"/"c89" too (same as 90), or a bare number (keeps the current extension mode).
        const m = input.trim().toLowerCase().match(/^(c|gnu)?(?:\+\+)?(\d+)$/);
        if (!m) throw new Error(t("code.ver.badStd", { value: input }));
        const num = m[2] === "89" ? "90" : m[2];
        const gnu = m[1] ? m[1] === "gnu" : ext(lang);
        let now = (await read(path)) ?? text;
        const stdRe = new RegExp(`(set\\s*\\(\\s*CMAKE_${lang}_STANDARD\\s+)\\d+`, "i");
        if (stdRe.test(now)) now = now.replace(stdRe, `$1${num}`);
        else {
          // Insert right after project(...), plus REQUIRED so the compiler can't silently fall back.
          const pm = now.match(/^\s*project\s*\([^)]*\)[^\n]*\n/im);
          const line = `set(CMAKE_${lang}_STANDARD ${num})\nset(CMAKE_${lang}_STANDARD_REQUIRED ON)\n`;
          now = pm ? now.replace(pm[0], `${pm[0]}\n${line}`) : `${line}${now}`;
        }
        const extRe = new RegExp(`(set\\s*\\(\\s*CMAKE_${lang}_EXTENSIONS\\s+)\\w+`, "i");
        if (extRe.test(now)) now = now.replace(extRe, `$1${gnu ? "ON" : "OFF"}`);
        else {
          // Always write it explicitly, so the file says what the compiler actually gets.
          const sm = now.match(new RegExp(`^.*CMAKE_${lang}_STANDARD(_REQUIRED)?\\s+\\w+\\s*\\)[^\\n]*\\n(?![\\s\\S]*CMAKE_${lang}_STANDARD)`, "im"));
          const line = `set(CMAKE_${lang}_EXTENSIONS ${gnu ? "ON" : "OFF"})\n`;
          now = sm ? now.replace(sm[0], `${sm[0]}${line}`) : `${now.trimEnd()}\n${line}`;
        }
        await fsApi.writeFile(path, now);
      },
      note: "code.ver.appliedNextBuild",
    };
  };
  return [...(uses("C") ? [setting("C")] : []), ...(uses("CXX") ? [setting("CXX")] : [])];
}

// ------------------------------------------------------------------ Java (Gradle)

const JAVA_VERSIONS: Suggestion[] = [
  { value: "27" },
  { value: "26" },
  { value: "25", tag: "LTS" },
  { value: "21", tag: "LTS" },
  { value: "17", tag: "LTS" },
  { value: "11", tag: "LTS" },
  { value: "8", tag: "LTS" },
];

async function java(root: string): Promise<VersionSetting | null> {
  let path: string | null = null, text = "";
  for (const f of ["app/build.gradle.kts", "build.gradle.kts", "app/build.gradle", "build.gradle"]) {
    const c = await read(joinPath(root, f));
    if (c !== null) {
      path ??= joinPath(root, f);
      if (/JavaLanguageVersion\.of\(/.test(c)) {
        path = joinPath(root, f);
        text = c;
        break;
      }
      if (!text) text = c;
    }
  }
  if (!path) return null;
  const current = text.match(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/)?.[1] ?? null;
  const file = path;
  return {
    id: "java",
    label: "Java (JDK)",
    current,
    chip: `Java ${current ?? t("code.ver.system")}`,
    options: async () => markCurrent(JAVA_VERSIONS, current),
    async apply(v) {
      const now = (await read(file)) ?? text;
      const next = /JavaLanguageVersion\.of\(/.test(now)
        ? now.replace(/JavaLanguageVersion\.of\(\s*\d+\s*\)/, `JavaLanguageVersion.of(${v})`)
        : `${now.trimEnd()}\n\njava {\n    toolchain {\n        languageVersion = JavaLanguageVersion.of(${v})\n    }\n}\n`;
      await fsApi.writeFile(file, next);
    },
    note: "code.ver.javaNote",
  };
}

// ------------------------------------------------------------------ entry

export async function versionSettings(p: Project | null): Promise<VersionSetting[]> {
  if (!p) return [];
  switch (p.kind) {
    case "uv":
      return [await python(p.root)];
    case "pnpm":
      return [await node(p.root)];
    case "cargo":
      return rust(p.root);
    case "cmake":
      return cmake(p.root);
    case "gradle": {
      const j = await java(p.root);
      return j ? [j] : [];
    }
    default:
      return [];
  }
}
