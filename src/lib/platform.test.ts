import { afterEach, describe, expect, test, vi } from "vitest";

async function load(ua: string) {
  vi.resetModules();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  return import("./platform");
}

afterEach(() => vi.restoreAllMocks());

describe("POSIX", () => {
  test("OS detection", async () => {
    expect((await load("Mozilla/5.0 (X11; Linux x86_64)")).OS).toBe("linux");
    expect((await load("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).IS_MAC).toBe(true);
  });

  test("q quotes only when needed", async () => {
    const { q } = await load("X11; Linux");
    expect(q("/home/me/proj")).toBe("/home/me/proj");
    expect(q("a b")).toBe("'a b'");
    expect(q("it's")).toBe(`'it'\\''s'`);
    expect(q("")).toBe("''");
    expect(q("$HOME")).toBe("'$HOME'");
  });

  test("cd / rmrf / runRel / exe", async () => {
    const p = await load("X11; Linux");
    expect(p.cd("/my dir")).toBe("cd '/my dir'");
    expect(p.rmrf("build")).toBe("rm -rf build");
    expect(p.runRel("build/app")).toBe("./build/app");
    expect(p.runRel("build/my app")).toBe("'./build/my app'");
    expect(p.exe("python")).toBe("python");
    expect(p.venvPython(".venv")).toBe(".venv/bin/python");
  });
});

describe("Windows", () => {
  const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

  test("OS detection", async () => {
    const p = await load(WIN);
    expect(p.OS).toBe("windows");
    expect(p.IS_WIN).toBe(true);
  });

  test("q converts drive / ./ paths to backslashes and double-quotes", async () => {
    const { q } = await load(WIN);
    expect(q("C:/Users/me")).toBe("C:\\Users\\me");
    expect(q("C:/Program Files/x")).toBe('"C:\\Program Files\\x"');
    expect(q("./build/app.exe")).toBe(".\\build\\app.exe");
    expect(q("plain")).toBe("plain");
  });

  test("q keeps %, double quotes and control characters out of every command", async () => {
    const { q, cd, runRel, rmrf, unlessExists, hasUnquotable } = await load(WIN);
    for (const s of ["%PATH%.py", "C:/a %USERNAME% b/x.py", "./100%.py", 'say "hi"', 'a" & calc & "b', "a\nb", "a\rb", "a\x1b.py"]) {
      for (const out of [q(s), cd(s), runRel(s), rmrf(s), unlessExists(s, "make")]) {
        expect(hasUnquotable(out)).toBe(true);
        expect(out).not.toMatch(/[%"\n\r\x1b]|calc/);
      }
    }
  });

  test("q still accepts ! in the host's own paths: Omega runs cmd.exe with delayed expansion off", async () => {
    const { q, hasUnquotable } = await load(WIN);
    expect(q("C:/Users/Bob!/a b.py")).toBe('"C:\\Users\\Bob!\\a b.py"');
    expect(hasUnquotable(q("C:/Users/Bob!/a b.py"))).toBe(false);
  });

  test("a name from another machine can't contain ! either", async () => {
    const { quotablePath } = await load(WIN);
    for (const s of ["!PATH!.py", "100%.py", 'a".py']) expect(quotablePath(s)).toBe(false);
    expect(quotablePath("a b.py")).toBe(true);
  });

  test("cd / rmrf / runRel / exe", async () => {
    const p = await load(WIN);
    expect(p.cd("D:/work")).toBe("cd /d D:\\work");
    expect(p.rmrf("build")).toBe("rmdir /s /q .\\build");
    expect(p.runRel("build/app.exe")).toBe(".\\build\\app.exe");
    expect(p.exe("python")).toBe("python.exe");
    expect(p.venvPython(".venv")).toBe(".venv/Scripts/python.exe");
  });
});
