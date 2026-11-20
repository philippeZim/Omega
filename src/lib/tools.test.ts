import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./terminal.svelte", () => ({ pathChanged: vi.fn() }));
import { setLocale } from "./i18n/index.svelte";
import { TOOLS } from "./tools.svelte";

describe("tool labels", () => {
  afterEach(() => setLocale("en"));

  // #63: the C/C++ compiler label was hard-coded English.
  test("C/C++ compiler label follows the UI language", () => {
    setLocale("de");
    expect(TOOLS.cc.label).toBe("C/C++-Compiler");
    setLocale("fr");
    expect(TOOLS.cc.label).toBe("Compilateur C/C++");
  });
});
