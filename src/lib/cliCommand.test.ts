import { beforeEach, describe, expect, it } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { cliCommand, launcherError, refreshCliCommand } from "./cliCommand.svelte";
import { setLocale } from "./i18n/index.svelte";

describe("omega command in Settings", () => {
  beforeEach(() => {
    setLocale("en");
    Object.assign(cliCommand, { status: null, error: "", busy: false });
  });

  it("translates the backend's launcher errors", () => {
    expect(launcherError("launcher:foreign")).toBe("Another program is already called omega.");
    expect(launcherError("launcher:test_instance")).toContain("Test instances");
    expect(launcherError("launcher:non_ascii")).not.toContain("launcher:");
    setLocale("de");
    expect(launcherError("launcher:foreign")).toBe("Ein anderes Programm heißt bereits omega.");
    setLocale("fr");
    expect(launcherError("launcher:foreign")).toContain("omega");
    expect(launcherError("disk full")).toBe("disk full");
  });

  it("a failed status check is shown, not hidden", async () => {
    mockIPC(() => {
      throw new Error("no home");
    });
    await refreshCliCommand();
    expect(cliCommand.status).toBeNull();
    expect(cliCommand.error).toContain("no home");
  });

  it("a working check clears the error", async () => {
    cliCommand.error = "old";
    const status = { state: "missing", path: "/b/omega", dir: "/b", onPath: true, available: true };
    mockIPC(() => status);
    await refreshCliCommand();
    expect(cliCommand.error).toBe("");
    expect(cliCommand.status?.state).toBe("missing");
  });
});
