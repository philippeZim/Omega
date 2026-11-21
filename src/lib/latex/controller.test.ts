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
const invoked: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    invoked.push(cmd);
    return cmd === "latex_available" ? Promise.resolve(true) : new Promise((res) => (finish = res));
  },
}));

import { latex, remoteLatex, remotePdfBytes, schedule } from "./controller.svelte";

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

  test("a shared tab compiles on the host and never locally", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const compile = vi.fn(async () => ({ result: { ...result, ok: true, pdf: "collab:pdf", diagnostics: [] }, bytes }));
    remoteLatex.compile = compile;
    const before = invoked.length;
    schedule("shared", "collab:main.tex", 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(compile).toHaveBeenCalledWith("collab:main.tex");
    expect(invoked.slice(before)).not.toContain("latex_compile");
    expect(latex.pdf).toBe("collab:pdf");
    expect([...remotePdfBytes()!]).toEqual([1, 2, 3]);
    remoteLatex.compile = null;
    schedule("shared2", "collab:other.tex", 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoked.slice(before)).not.toContain("latex_compile");
    schedule("a0", null, 0); // leave the shared tab for the next test
    await vi.advanceTimersByTimeAsync(1);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
  });

  test("a change that may not compile updates the outline only", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
    schedule("gated", null, 0);
    await vi.advanceTimersByTimeAsync(1);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
    const before = invoked.length;
    schedule("gated", null, 0, false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(invoked.slice(before)).not.toContain("latex_compile");
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
