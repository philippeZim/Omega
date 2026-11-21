import { describe, expect, test, vi } from "vitest";

// The real quoting rules: platform.ts reads the OS from the user agent when it loads.
vi.hoisted(() => Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0)", configurable: true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string, a?: { part?: string }) => (cmd === "lang_workdir" ? `C:/Temp/omega-lang/${a!.part}` : null),
}));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), fsApi: { readFile: async () => "", exists: async () => false, listDir: async () => [] } }));

import { overrideRun } from "./langRun";
import { hasUnquotable } from "../platform";

describe("a file set to another language on Windows (#149)", () => {
  test("clang is used and the program gets .exe", async () => {
    const r = (await overrideRun("c", "C:/w/prog", "tsx"))!;
    expect(r.pre).toBe("clang -x c -g -Wall C:\\w\\prog -o C:\\Temp\\omega-lang\\bin\\omega_out.exe");
  });

  test.each(["C:/w/100%path/prog", 'C:/w/a"b/prog'])("%s is refused where the name reaches the command", async (file) => {
    for (const id of ["c", "cpp", "python", "rust"] as const) {
      const r = (await overrideRun(id, file, "tsx"))!;
      expect(hasUnquotable(`${r.pre ?? ""} ${r.cmd}`), id).toBe(true);
    }
  });

  test("a copy's fixed name keeps such a file out of the command", async () => {
    const r = (await overrideRun("javascript", "C:/w/100%path/prog", "tsx"))!;
    expect(r.cmd).toBe("node C:\\Temp\\omega-lang\\run\\omega_main.js");
    expect(hasUnquotable(r.cmd)).toBe(false);
  });
});
