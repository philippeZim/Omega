import { beforeEach, describe, expect, test, vi } from "vitest";

const view = { state: { doc: { lines: 3, line: (n: number) => ({ from: n, to: n }) } }, dispatch: vi.fn() };
let mode = "latex";
vi.mock("../editor", () => ({
  getText: () => "\\documentclass{article}\n\\begin{document}\nx",
  getView: () => view,
  isActive: () => true,
  activeMode: () => mode,
  viewsOf: () => (view ? [{ view, mode, pane: "main" }] : []),
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

import { compileNow, latex, remoteLatex, remotePdfBytes, schedule } from "./controller.svelte";

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

  test("text from a guest without run waits for the host's Compile, which stays valid until the next change", async () => {
    const changes = await import("../collab/guestChanges");
    changes.guestChangeHooks.name = () => "Ada";
    await vi.advanceTimersByTimeAsync(1000);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
    schedule("doc", "/proj/main.tex", 0);
    await vi.advanceTimersByTimeAsync(1);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);

    changes.noteGuestChange("g", "/proj", "main.tex");
    expect(latex.pausedBy).toBe("Ada");
    let before = invoked.length;
    schedule("doc", "/proj/main.tex", 0); // a keystroke
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoked.slice(before)).not.toContain("latex_compile");
    schedule("doc2", "/proj/other.tex", 0); // another file of that project
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoked.slice(before)).not.toContain("latex_compile");
    schedule("doc", "/proj/main.tex", 0);
    await vi.advanceTimersByTimeAsync(1);

    compileNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(latex.pausedBy).toBeNull();
    expect(invoked.slice(before)).toContain("latex_compile");
    finish(result);
    await vi.advanceTimersByTimeAsync(1);

    before = invoked.length;
    schedule("doc", "/proj/main.tex", 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoked.slice(before)).toContain("latex_compile");
    finish(result);
    await vi.advanceTimersByTimeAsync(1);

    changes.noteGuestChange("g", "/proj", "main.tex");
    before = invoked.length;
    schedule("doc", "/proj/main.tex", 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoked.slice(before)).not.toContain("latex_compile");
    changes.resumeCompiling("doc", "/proj/main.tex");
  });

  test("a guest's change during a compile starts no second one, and the host is told", async () => {
    const changes = await import("../collab/guestChanges");
    await vi.advanceTimersByTimeAsync(1000);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
    schedule("during", "/during/main.tex", 0);
    await vi.advanceTimersByTimeAsync(1); // compiling now
    const before = invoked.length;
    schedule("during", "/during/main.tex", 0); // an edit meanwhile asks for another run
    await vi.advanceTimersByTimeAsync(1);
    changes.noteGuestChange("g", "/during", "main.tex");
    expect(latex.guestInRun).toBe(false);
    finish({ ...result, ok: true, pdf: "/x.pdf", diagnostics: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(latex.guestInRun).toBe(true);
    expect(invoked.slice(before)).not.toContain("latex_compile");
    compileNow();
    expect(latex.guestInRun).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
  });

  test("a compile timer already running doesn't take a guest's text in", async () => {
    const changes = await import("../collab/guestChanges");
    await vi.advanceTimersByTimeAsync(1000);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
    schedule("late", "/late/main.tex", 0);
    await vi.advanceTimersByTimeAsync(1);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
    const before = invoked.length;
    schedule("late", "/late/main.tex"); // the host typed, the debounce is running
    changes.noteGuestChange("g", "/late", "main.tex"); // then the guest's edit arrived
    await vi.advanceTimersByTimeAsync(2000);
    expect(invoked.slice(before)).not.toContain("latex_compile");
    changes.resumeCompiling("late", "/late/main.tex");
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
