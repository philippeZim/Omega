import { beforeEach, describe, expect, test, vi } from "vitest";

const view = { state: { doc: { lines: 3, line: (n: number) => ({ from: n, to: n }) } }, dispatch: vi.fn() };
let mode = "latex";
vi.mock("../editor", () => ({
  getText: () => "\\documentclass{article}\n\\begin{document}\nx",
  getView: () => view,
  isActive: () => true,
  activeMode: () => mode,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../fsWatch.svelte", () => ({ onFilesChanged: vi.fn() }));
vi.mock("../tools.svelte", () => ({ ensureTools: vi.fn() }));
vi.mock("@codemirror/lint", () => ({ setDiagnostics: (_s: unknown, d: unknown) => ({ diagnostics: d }) }));
let finish: (r: unknown) => void = () => {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    cmd === "latex_available"
      ? Promise.resolve(true)
      : new Promise((res) => (finish = res)),
}));

import { latex, schedule } from "./controller.svelte";

const result = {
  ok: false,
  pdf: null,
  diagnostics: [{ file: "", line: 2, message: "Undefined control sequence", severity: "error" }],
  log: "",
  sync: [],
  millis: 5,
};

async function compile(id: string) {
  schedule(id, null, 0);
  await vi.advanceTimersByTimeAsync(1);
}

describe("latex controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    view.dispatch.mockClear();
    mode = "latex";
  });

  test("applies diagnostics when the compile ends in LaTeX mode", async () => {
    await compile("a");
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
    expect(latex.status).toBe("error");
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  test("a compile that finishes after leaving LaTeX mode leaves the editor alone", async () => {
    await compile("b");
    mode = "text";
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.dispatch).not.toHaveBeenCalled();
  });
});
