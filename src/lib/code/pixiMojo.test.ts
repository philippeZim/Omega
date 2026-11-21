import { afterEach, beforeEach, describe, expect, test } from "vitest";

// Runs the real shell script, through Node (no @types/node here).
const proc = (globalThis as any).process;
const { execFileSync, spawnSync } = proc.getBuiltinModule("node:child_process");
const { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = proc.getBuiltinModule("node:fs");
const { tmpdir } = proc.getBuiltinModule("node:os");
const { dirname, join } = proc.getBuiltinModule("node:path");

const LAUNCHER = join(proc.cwd(), "src/lib/code/pixi-mojo.sh");

const ACTIVATION = `#!/bin/bash
export MODULAR_HOME="\${CONDA_PREFIX}/share/max"

if ! [[ -f "\${MODULAR_HOME}/firstActivation" ]]; then
  touch "\${MODULAR_HOME}/firstActivation"
  curl --silent https://telemetry.modular.com:443/v1/logs > /dev/null 2>&1 &
fi
`;

const FAKE_PIXI = `#!/bin/sh
printf '%s\\n' "$*" >> "$LOG"
case "$1" in
  info) cat "$INFO" ;;
  install) exit "\${INSTALL_RC:-0}" ;;
  run)
    printf 'run telemetry=%s crash=%s\\n' "$MODULAR_TELEMETRY_ENABLED" "$MODULAR_CRASH_REPORTING_ENABLED" >> "$LOG"
    while [ "$1" != "--" ]; do shift; done
    shift
    for a in "$@"; do printf '[%s]' "$a" >> "$LOG"; done
    echo >> "$LOG"
    ;;
esac
`;

const FAKE_MOJO = `#!/bin/sh
printf 'direct home=%s telemetry=%s crash=%s args=' "$MODULAR_HOME" "$MODULAR_TELEMETRY_ENABLED" "$MODULAR_CRASH_REPORTING_ENABLED" >> "$LOG"
for a in "$@"; do printf '[%s]' "$a" >> "$LOG"; done
echo >> "$LOG"
`;

let base: string, root: string, log: string, info: string;

const write = (path: string, text: string, exec = false) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (exec) chmodSync(path, 0o755);
};

function makeEnv(name: string, script: string | null = ACTIVATION) {
  const prefix = join(root, ".pixi/envs", name);
  write(join(prefix, "bin/mojo"), FAKE_MOJO, true);
  mkdirSync(join(prefix, "share/max"), { recursive: true });
  if (script !== null) write(join(prefix, "etc/conda/activate.d/10-activate-max.sh"), script);
  return prefix;
}

/** What `pixi info --json` prints, in its real layout. */
function setInfo(envs: { name: string; deps: string[]; tasks?: string[] }[]) {
  const list = (key: string, items: string[]) => (items.length ? `      "${key}": [\n${items.map((d) => `        "${d}"`).join(",\n")}\n      ],` : `      "${key}": [],`);
  const body = envs
    .map((e) => `    {\n      "name": "${e.name}",\n${list("dependencies", e.deps)}\n      "pypi_dependencies": [],\n      "platforms": [\n        {\n          "name": "linux-64"\n        }\n      ],\n${list("tasks", e.tasks ?? [])}\n      "prefix": "${join(root, ".pixi/envs", e.name)}"\n    }`)
    .join(",\n");
  writeFileSync(info, `{\n  "project_info": {\n    "name": "m"\n  },\n  "environments_info": [\n${body}\n  ],\n  "config_locations": []\n}\n`);
}

function launch(args: string[] = ["run", "main.mojo"], extra: Record<string, string> = {}) {
  const r = spawnSync("sh", [LAUNCHER, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: `${join(base, "bin")}:/usr/bin:/bin`, LOG: log, INFO: info, MODULAR_TELEMETRY_ENABLED: "1", MODULAR_HOME: "/elsewhere", ...extra },
  });
  return { code: r.status, err: r.stderr, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

const marker = (env: string) => join(root, ".pixi/envs", env, "share/max/firstActivation");

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "omega-pixi-mojo-"));
  root = join(base, "my project");
  mkdirSync(root);
  writeFileSync(join(root, "pixi.toml"), "[workspace]\n");
  log = join(base, "log");
  info = join(base, "info.json");
  write(join(base, "bin/pixi"), FAKE_PIXI, true);
  setInfo([{ name: "default", deps: ["mojo"] }]);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe.skipIf(proc.platform === "win32")("pixi-mojo launcher", () => {
  test("installs, writes the marker, then runs without a re-sync and with telemetry off", () => {
    makeEnv("default");
    const r = launch();
    expect(r.code).toBe(0);
    expect(existsSync(marker("default"))).toBe(true);
    const lines = r.log.trim().split("\n");
    expect(lines[0]).toMatch(/^info /);
    expect(lines[1]).toBe("install --manifest-path pixi.toml -e default");
    expect(lines[2]).toBe("run --manifest-path pixi.toml --as-is -e default -- mojo run main.mojo");
    expect(lines[3]).toBe("run telemetry=0 crash=0");
    expect(lines[4]).toBe("[mojo][run][main.mojo]");
  });

  test("a failed install stops: no run, no marker, its exit code", () => {
    makeEnv("default");
    const r = launch(["run", "main.mojo"], { INSTALL_RC: "7" });
    expect(r.code).toBe(7);
    expect(r.log).not.toMatch(/^run /m);
    expect(r.log).not.toContain("direct");
    expect(existsSync(marker("default"))).toBe(false);
  });

  test("uses mojoproject.toml when there is no pixi.toml", () => {
    rmSync(join(root, "pixi.toml"));
    writeFileSync(join(root, "mojoproject.toml"), "[project]\n");
    makeEnv("default");
    expect(launch().log).toContain("install --manifest-path mojoproject.toml -e default");
  });

  test("the marker goes into the environment that has Mojo, and only there", () => {
    makeEnv("default", null);
    makeEnv("other", ACTIVATION);
    makeEnv("mj");
    setInfo([{ name: "default", deps: ["zlib"] }, { name: "mj", deps: ["mojo", "zlib"] }, { name: "other", deps: ["bzip2"] }]);
    const r = launch();
    expect(r.log).toContain("--as-is -e mj -- mojo");
    expect(existsSync(marker("mj"))).toBe(true);
    expect(existsSync(marker("default"))).toBe(false);
    expect(existsSync(marker("other"))).toBe(false);
  });

  test("default wins when several environments have Mojo", () => {
    makeEnv("default");
    makeEnv("gpu");
    setInfo([{ name: "gpu", deps: ["mojo"] }, { name: "default", deps: ["mojo"] }]);
    expect(launch().log).toContain("--as-is -e default -- mojo");
    expect(existsSync(marker("gpu"))).toBe(false);
  });

  test("several candidates without a default: never guesses", () => {
    makeEnv("a");
    makeEnv("b");
    setInfo([{ name: "default", deps: ["zlib"] }, { name: "a", deps: ["mojo"] }, { name: "b", deps: ["mojo"] }]);
    const r = launch();
    expect(r.code).toBe(1);
    expect(r.err).toContain("can't tell");
    expect(r.log).not.toMatch(/^(install|run) /m);
    expect(r.log).not.toContain("direct");
  });

  test("when pixi can't say, the only environment with Mojo runs directly", () => {
    const prefix = makeEnv("solo");
    writeFileSync(info, "not json");
    const r = launch();
    expect(r.log).toContain(`direct home=${prefix}/share/max telemetry=0 crash=0 args=[run][main.mojo]`);
    expect(r.log).not.toMatch(/^run /m);
    expect(existsSync(marker("solo"))).toBe(false);
  });

  test("a task called mojo can't replace the compiler", () => {
    const prefix = makeEnv("default");
    setInfo([{ name: "default", deps: ["mojo"], tasks: ["mojo"] }]);
    const r = launch();
    expect(r.log).toContain(`direct home=${prefix}/share/max`);
    expect(r.log).not.toMatch(/^run /m);
  });

  test("other tasks don't change anything", () => {
    makeEnv("default");
    setInfo([{ name: "default", deps: ["mojo"], tasks: ["mojo-fmt", "test"] }]);
    expect(launch().log).toMatch(/^run --manifest-path/m);
  });

  test.each([
    ["the marker check is gone", ACTIVATION.replace('if ! [[ -f "${MODULAR_HOME}/firstActivation" ]]; then', "if true; then")],
    ["another marker", ACTIVATION.replaceAll("firstActivation", "firstRun")],
    ["a contact outside the guarded block", `${ACTIVATION}curl https://telemetry.modular.com/v2\n`],
    ["a contact before the guarded block", ACTIVATION.replace("if !", "wget https://modular.com/x\nif !")],
    ["MODULAR_HOME moved", ACTIVATION.replace("/share/max", "/share/other")],
  ])("%s: no activation, mojo runs directly", (_name, script) => {
    const prefix = makeEnv("default", script);
    const r = launch();
    expect(r.log).toContain(`direct home=${prefix}/share/max telemetry=0 crash=0`);
    expect(r.log).not.toMatch(/^run /m);
    expect(existsSync(marker("default"))).toBe(false);
  });

  test("a second, unrelated script that calls curl also means no activation", () => {
    const prefix = makeEnv("default");
    write(join(prefix, "etc/conda/activate.d/20-other.sh"), "curl https://example.com\n");
    expect(launch().log).not.toMatch(/^run /m);
  });

  test.each([
    "wget -q https://example.com",
    "exec 3<>/dev/tcp/example.com/443",
    "nc example.com 443 < /dev/null",
    "python3 -c 'print(1)'",
    "perl -e 1",
    "ruby -e 1",
    "node -e 1",
    "echo http://example.com",
    "socat - TCP:example.com:443",
    'eval "$X"',
  ])("a script outside the known shape that uses the network or an interpreter goes direct: %s", (line) => {
    const prefix = makeEnv("default");
    write(join(prefix, "etc/conda/activate.d/20-other.sh"), `#!/bin/sh\n${line}\n`);
    const r = launch();
    expect(r.log).toContain(`direct home=${prefix}/share/max`);
    expect(r.log).not.toMatch(/^run /m);
    expect(existsSync(marker("default"))).toBe(false);
  });

  test.each(["python3 -c 1", "nc example.com 443", "exec 3<>/dev/tcp/example.com/443"])("the same line in Modular's script, outside its block, goes direct: %s", (line) => {
    const prefix = makeEnv("default", `${ACTIVATION}${line}\n`);
    expect(launch().log).toContain(`direct home=${prefix}/share/max`);
  });

  test("an interpreter inside the guarded block is what the real script does", () => {
    makeEnv("default", ACTIVATION.replace("  curl", "  now=$(python3 -c 'print(1)')\n  curl"));
    expect(launch().log).toMatch(/^run --manifest-path/m);
  });

  test.each(["export FOO=1", "export ENCODING=utf-8", "# nothing to see, sync done", "export NODES=4 PERLITE=1"])("a clearly harmless script keeps pixi run: %s", (line) => {
    const prefix = makeEnv("default");
    write(join(prefix, "etc/conda/activate.d/20-other.sh"), `#!/bin/sh\n${line}\n`);
    expect(launch().log).toMatch(/^run --manifest-path/m);
    expect(existsSync(marker("default"))).toBe(true);
  });

  test("a script that can't be read doesn't count as harmless", () => {
    const prefix = makeEnv("default");
    const other = join(prefix, "etc/conda/activate.d/20-other.sh");
    write(other, "export FOO=1\n");
    chmodSync(other, 0o000);
    const r = launch();
    chmodSync(other, 0o644);
    expect(r.log).toContain(`direct home=${prefix}/share/max`);
    expect(r.log).not.toMatch(/^run /m);
  });

  test("no Modular script: no marker, plain pixi run", () => {
    makeEnv("default", null);
    const r = launch();
    expect(existsSync(marker("default"))).toBe(false);
    expect(r.log).toMatch(/^run --manifest-path/m);
  });

  test("an existing marker stays as it is", () => {
    makeEnv("default");
    writeFileSync(marker("default"), "kept");
    launch();
    expect(readFileSync(marker("default"), "utf8")).toBe("kept");
  });

  test("a marker that is a symlink is never followed", () => {
    makeEnv("default");
    const target = join(base, "target");
    symlinkSync(target, marker("default"));
    const r = launch();
    expect(existsSync(target)).toBe(false);
    expect(r.log).toContain("direct home=");
    expect(r.log).not.toMatch(/^run /m);
  });

  test("share/max pointing out of the project is never written to", () => {
    const prefix = makeEnv("default");
    const outside = join(base, "outside");
    mkdirSync(outside);
    rmSync(join(prefix, "share/max"), { recursive: true });
    symlinkSync(outside, join(prefix, "share/max"));
    const r = launch();
    expect(readdirSync(outside)).toEqual([]);
    expect(r.log).not.toMatch(/^run /m);
  });

  test("an environment outside .pixi is never written to", () => {
    const outside = join(base, "detached");
    write(join(outside, "bin/mojo"), FAKE_MOJO, true);
    write(join(outside, "etc/conda/activate.d/10-activate-max.sh"), ACTIVATION);
    mkdirSync(join(outside, "share/max"), { recursive: true });
    mkdirSync(join(root, ".pixi/envs"), { recursive: true });
    symlinkSync(outside, join(root, ".pixi/envs/default"));
    const r = launch();
    expect(existsSync(join(outside, "share/max/firstActivation"))).toBe(false);
    expect(r.log).toContain("direct home=");
    expect(r.log).not.toMatch(/^run /m);
  });

  test("only the marker is added to the project", () => {
    makeEnv("default");
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n: string) => (lstatSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
    const before = files(root);
    launch();
    expect(files(root).filter((f) => !before.includes(f))).toEqual([marker("default")]);
  });

  test.each([[["run"]], [["direct"]]])("awkward arguments stay intact (%s)", ([mode]) => {
    const prefix = makeEnv("default");
    if (mode === "direct") setInfo([{ name: "default", deps: ["mojo"], tasks: ["mojo"] }]);
    const args = ["build", "it's a.mojo", "./-x.mojo", "a$HOME.mojo", "g*.mojo", 'q"x.mojo', "-o", "build/a b"];
    const r = launch(args);
    expect(r.log).toContain(args.map((a) => `[${a}]`).join(""));
    expect(prefix).toContain("my project");
  });

  test("is plain POSIX sh", () => {
    expect(() => execFileSync("sh", ["-n", LAUNCHER])).not.toThrow();
    expect(readFileSync(LAUNCHER, "utf8")).not.toContain("[[ -f \"$");
  });
});
