// @ts-expect-error No Node types in this project; the test runs under Node.
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { packageAction, PACKAGE_LIMITS, quotePackageArg, splitPackages, validPackage, validPackages } from "./packageInput";
import { detectProject } from "./projects";

/** Refused in every ecosystem, for add and remove. */
const ATTACKS = [
  "-e",
  "--index-url=https://evil.test",
  "--registry=https://evil.test",
  "--config=x",
  "-",
  "--",
  "https://evil.test/x.whl",
  "http://evil.test/x",
  "git+https://evil.test/x.git",
  "git+ssh://git@evil.test/x",
  "ssh://git@evil.test/x",
  "file:///etc/passwd",
  "file:../x",
  "./local",
  "../local",
  "/etc/passwd",
  "~/x",
  "C:\\x",
  "a\\b",
  "a;id",
  "a&&id",
  "a&id",
  "a|id",
  "a||id",
  "$(id)",
  "a$(id)",
  "`id`",
  "a`id`",
  "$HOME",
  "a$HOME",
  "%PATH%",
  "a%PATH%",
  "a'b",
  "a'; id; '",
  'a"b',
  'a" & id & "',
  "a b",
  "a\tb",
  "a\nid",
  "a\rid",
  "a\0b",
  "a\x1b[2Jb",
  "a\x7fb",
  "a\u00a0b",
  "a\u2028b",
  "a\u202eb",
  "(id)",
  "a(b)",
  "{a,b}",
  "a{b}",
  "a#b",
  "a?b",
  "a:b",
  "\u0430bc",
  "",
  " ",
  "x".repeat(PACKAGE_LIMITS.length + 1),
];

describe.each(["uv", "pnpm", "cargo"])("%s: injection attempts are refused", (kind) => {
  test.each(ATTACKS)("%j", (token) => {
    expect(validPackage(kind, "add", token)).toBe(false);
    expect(validPackage(kind, "remove", token)).toBe(false);
  });
});

describe("uv", () => {
  test.each(["requests", "Flask", "ruamel.yaml", "typing_extensions", "scikit-learn", "requests[socks]", "uvicorn[standard,dev]", "requests==2.32.3", "numpy>=1.26,<3", "django~=5.0", "foo!=1.5", "foo==1.*", "foo==1!2.0", "foo==1.0rc1", "foo==1.0.post1", "foo==1.0+local.1", "a[b]>=1"])("accepts %s", (x) => {
    expect(validPackage("uv", "add", x)).toBe(true);
  });
  test.each(["foo @ https://x", "foo@https://x", "foo@1.0", "foo;python_version<'3'", "foo[a;b]", "foo[]", "foo==", "foo==1;id", "foo>=1,", "foo.whl", "foo.tar.gz", "foo.zip", "foo==1,==2,==3,==4,==5", "foo=1", "foo>>1"])("refuses %s", (x) => {
    expect(validPackage("uv", "add", x)).toBe(false);
  });
  test("remove takes plain names only", () => {
    expect(validPackage("uv", "remove", "requests")).toBe(true);
    for (const x of ["requests==1.0", "requests[socks]", "requests>=1"]) expect(validPackage("uv", "remove", x)).toBe(false);
  });
});

describe("pnpm", () => {
  test.each(["zod", "@types/node", "lodash.debounce", "JSONStream", "zod@3", "zod@3.23.8", "zod@^3.0.0", "zod@~3.1", "zod@>=3", "zod@latest", "zod@next", "@scope/pkg@1.2.3-beta.1", "zod@*", "zod@3.x"])("accepts %s", (x) => {
    expect(validPackage("pnpm", "add", x)).toBe(true);
  });
  test.each(["user/repo", "github:user/repo", "npm:evil", "alias@npm:evil", "workspace:*", "zod@workspace:*", "zod@file:../x", "zod@link:../x", "zod@github:a/b", "zod@https://x", "zod@git+https://x", "zod@a/b", "zod@./x", "foo.tgz", "foo.tar.gz", "zod@x.tgz", ".hidden", "_private", "@/x", "@a/", "@a/b/c", "zod@", "zod@1@2", "zod@>=1 <2"])("refuses %s", (x) => {
    expect(validPackage("pnpm", "add", x)).toBe(false);
  });
  test("remove takes plain names only", () => {
    expect(validPackage("pnpm", "remove", "@types/node")).toBe(true);
    expect(validPackage("pnpm", "remove", "zod@3")).toBe(false);
  });
});

describe("cargo", () => {
  test.each(["serde", "serde_json", "tokio-util", "serde@1", "serde@1.0.200", "serde@^1.0", "serde@~1.2", "serde@=1.2.3", "serde@>=1,<2", "serde@1.*", "foo@1.0.0-alpha.1"])("accepts %s", (x) => {
    expect(validPackage("cargo", "add", x)).toBe(true);
  });
  test.each(["serde/derive", "serde@latest", "serde@https://x", "1serde", "_serde", "serde@", "serde@1@2", "a.b", "serde@1,", "serde@1,2,3,4,5"])("refuses %s", (x) => {
    expect(validPackage("cargo", "add", x)).toBe(false);
  });
});

test("a kind without package actions accepts nothing", () => {
  for (const kind of ["cmake", "gradle", "file", "__proto__"]) expect(validPackage(kind, "add", "foo")).toBe(false);
});

test("the list is limited, and one bad word refuses all of it", () => {
  expect(validPackages("uv", "add", ["a", "b"])).toBe(true);
  expect(validPackages("uv", "add", [])).toBe(false);
  expect(validPackages("uv", "add", ["a", "--index-url=https://evil.test"])).toBe(false);
  expect(validPackages("uv", "add", Array(PACKAGE_LIMITS.count + 1).fill("a"))).toBe(false);
});

test("splitPackages splits on any whitespace", () => {
  expect(splitPackages("  a\tb  c\n")).toEqual(["a", "b", "c"]);
});

describe("packageAction", () => {
  test("names what changes packages, per project type", () => {
    const ids = (kind: string, all: string[]) => all.filter((id) => packageAction(kind, id));
    expect(ids("cargo", ["add", "update", "check", "clean", "fmt"])).toEqual(["add", "update"]);
    expect(ids("uv", ["sync", "add", "adddev", "remove", "lock", "fmt", "lint"])).toEqual(["sync", "add", "adddev", "remove", "lock"]);
    expect(ids("pnpm", ["install", "add", "adddev", "remove", "script:install", "script:add"])).toEqual(["install", "add", "adddev", "remove"]);
    expect(ids("gradle", ["deps", "wrapper", "clean"])).toEqual([]);
    expect(ids("cmake", ["configure", "clean"])).toEqual([]);
  });

  test("inherited object keys are not actions", () => {
    for (const id of ["constructor", "__proto__", "toString"]) expect(packageAction("uv", id)).toBeNull();
    expect(packageAction("constructor", "add")).toBeNull();
  });

  test("every action that asks for input in a detected project is a package action", async () => {
    const markers: Record<string, string> = { cargo: "Cargo.toml", uv: "pyproject.toml", pnpm: "package.json", cmake: "CMakeLists.txt", gradle: "build.gradle" };
    for (const [kind, marker] of Object.entries(markers)) {
      mockIPC((cmd, args) => {
        const path = (args as { path?: string })?.path ?? "";
        if (cmd === "path_exists") return path === `/p/${marker}`;
        if (cmd === "read_file") return marker === "package.json" ? "{}" : "";
        if (cmd === "list_dir") return [];
        if (cmd === "platform_info") return { os: "linux", arch: "x86_64", home: "/h", tmp: "/tmp", tools: "/t" };
        return null;
      });
      const p = (await detectProject(null, "/p"))!;
      expect(p.kind).toBe(kind);
      for (const a of p.more.filter((m) => m.ask)) expect(packageAction(kind, a.id)?.input, `${kind}:${a.id}`).toBeTruthy();
    }
  });
});

describe("quoting", () => {
  /** What a real POSIX shell passes to a program for this word. */
  const argv = (word: string) => execFileSync("sh", ["-c", `printf '%s\\0' ${word}`], { cwd: "/" }).toString().split("\0").slice(0, -1);

  test.each(["requests", "requests[socks]", "numpy>=1.26,<3", "foo!=1.5", "foo==1.*", "foo==1!2.0", "foo==1.0+local.1", "@types/node", "zod@^3.0.0", "zod@~3.1", "zod@>=3", "zod@*", "serde@>=1,<2", "serde@1.*"])("%s stays one literal word in a real shell", (x) => {
    expect(argv(quotePackageArg(x, false))).toEqual([x]);
  });

  test("Windows words with special characters are double quoted", () => {
    expect(quotePackageArg("zod@^3", true)).toBe('"zod@^3"');
    expect(quotePackageArg("numpy>=1,<3", true)).toBe('"numpy>=1,<3"');
    expect(quotePackageArg("zod", true)).toBe("zod");
  });

  test("no character that could leave the quotes passes validation", () => {
    for (let c = 0; c < 0x250; c++) {
      const ch = String.fromCharCode(c);
      if (!`'"$\`\\%&|;()\n\r\t `.includes(ch) && c >= 0x20 && c < 0x7f) continue;
      for (const kind of ["uv", "pnpm", "cargo"]) {
        for (const x of [`a${ch}b`, `a==1${ch}`, `a@1${ch}`, `a[b${ch}]`]) expect(validPackage(kind, "add", x), JSON.stringify(x)).toBe(false);
      }
    }
  });
});
