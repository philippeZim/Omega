// Guest LaTeX on the host (latexRemote.svelte.ts): what a guest can ask for, and what it gets back.
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  methods: new Map<string, any>(),
  capListeners: [] as ((before: string[], now: string[]) => void)[],
  invoke: vi.fn(),
  texts: vi.fn(),
  check: vi.fn(async (_rel: string) => true),
  openRemote: vi.fn(),
  recompile: vi.fn(),
  remote: {} as Record<string, any>,
  gate: { fileChangeBlocked: () => false },
  hooks: { editBlocksCompile: () => false },
  collab: { role: "host", myPeer: "me", participants: [] as any[] },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./collab.svelte", () => ({ collab: h.collab }));
vi.mock("./rpc.svelte", () => ({
  RpcFail: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  call: vi.fn(),
  hasCapability: (peer: string, cap: string) => !!h.collab.participants.find((p) => p.peer === peer)?.caps.includes(cap),
  isObj: (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v),
  onCapabilitiesChanged: (fn: (b: string[], n: string[]) => void) => void h.capListeners.push(fn),
  publish: vi.fn(),
  registerMethod: (d: any) => void h.methods.set(d.name, d),
  registerTopic: vi.fn(),
  rpcErrorText: (c: string) => c,
  subscribe: vi.fn(),
}));
vi.mock("./share.svelte", () => ({
  applyingEditWithoutRun: () => false,
  docEditListeners: new Set(),
  guestScope: () => ({ root: "/p", live: () => true, check: h.check }),
  hostCompileTexts: h.texts,
  openRemote: h.openRemote,
}));
vi.mock("../latex/controller.svelte", () => ({ applyProgress: vi.fn(), autoCompileGate: h.gate, recompileRemote: h.recompile, remoteLatex: h.remote }));
vi.mock("../fsWatch.svelte", () => ({ onFilesChanged: vi.fn() }));
vi.mock("../state.svelte", () => ({ collabHooks: h.hooks }));
vi.mock("../i18n/index.svelte", () => ({ t: (k: string) => k }));

const { toGuestResult } = await import("./latexRemote.svelte");
const method = h.methods.get("latex.compile");
const ctx = (signal = new AbortController().signal) => ({ peer: "g1", signal });

beforeEach(() => {
  h.invoke.mockReset();
  h.texts.mockReset();
  h.check.mockReset().mockResolvedValue(true);
  h.openRemote.mockReset();
  h.recompile.mockReset();
  h.collab.participants = [];
});

test("compiling needs run, and the guest can only name a doc", () => {
  expect(method.capability).toBe("run");
  expect(method.validate({ key: "main.tex", nonce: "abc1", flags: ["-Z", "shell-escape"], root: "/etc", env: { A: "1" } })).toEqual({ key: "main.tex", nonce: "abc1" });
  for (const bad of [{ key: 1, nonce: "a" }, { key: "a", nonce: "../x" }, { key: "a" }, null]) expect(method.validate(bad)).toBeNull();
});

test("the host compiles the current shared text with its own folder", async () => {
  h.texts.mockReturnValue({ key: "main.tex", text: "unsaved", overlays: [{ rel: "ch.tex", text: "t" }, { rel: "link.tex", text: "x" }] });
  h.check.mockImplementation(async (rel: string) => rel !== "link.tex");
  h.invoke.mockResolvedValue({ ok: true });
  await method.handle({ key: "main.tex", nonce: "n1" }, ctx());
  expect(h.texts).toHaveBeenCalledWith("main.tex", "g1");
  expect(h.invoke).toHaveBeenCalledWith("latex_guest_compile", { job: "g1:n1", root: "/p", file: "main.tex", content: "unsaved", overlays: [{ rel: "ch.tex", text: "t" }] });
});

test("a doc the guest doesn't have open, or outside the project, doesn't compile", async () => {
  h.texts.mockReturnValue(null);
  await expect(method.handle({ key: "x.tex", nonce: "n" }, ctx())).rejects.toMatchObject({ code: "latex_no_doc" });
  h.texts.mockReturnValue({ key: "x.tex", text: "", overlays: [] });
  h.check.mockResolvedValue(false);
  await expect(method.handle({ key: "x.tex", nonce: "n" }, ctx())).rejects.toMatchObject({ code: "path_refused" });
  expect(h.invoke).not.toHaveBeenCalled();
});

test("the signal cancels the running compile", async () => {
  h.texts.mockReturnValue({ key: "main.tex", text: "", overlays: [] });
  let finish!: (v: unknown) => void;
  h.invoke.mockImplementation((cmd: string) => (cmd === "latex_guest_compile" ? new Promise((r) => (finish = r)) : Promise.resolve()));
  const ctl = new AbortController();
  const running = method.handle({ key: "main.tex", nonce: "n2" }, ctx(ctl.signal));
  await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith("latex_guest_compile", expect.anything()));
  ctl.abort();
  expect(h.invoke).toHaveBeenCalledWith("latex_guest_cancel", { job: "g1:n2" });
  finish({ ok: false });
  await running;
});

test("a result shows project files as guest tabs and drops everything else", () => {
  const { result, bytes } = toGuestResult({
    ok: false,
    pdf: btoa("PDF"),
    diagnostics: [{ file: "ch/one.tex", line: 2, message: "m", severity: "error" }, { file: "", line: 0, message: "n", severity: "warning" }],
    log: "",
    sync: [{ page: 1, file: "main.tex", line: 1, x: 0, y: 0, w: 1, h: 1 }],
    millis: 1,
  });
  expect(new TextDecoder().decode(bytes!)).toBe("PDF");
  expect(result.pdf).toBe("collab:pdf");
  expect(result.diagnostics.map((d) => d.file)).toEqual(["collab:ch/one.tex", ""]);
  expect(result.sync[0].file).toBe("collab:main.tex");
});

test("a jump puts the cursor on the line of the shared file", () => {
  h.remote.openAt("collab:ch/one.tex", 7);
  expect(h.openRemote).toHaveBeenCalledWith("ch/one.tex", 7, [0, 0]);
});

test("getting run back recompiles, other changes don't", () => {
  const changed = h.capListeners[0];
  changed(["edit", "run"], ["edit"]);
  changed(["edit"], ["edit", "git"]);
  expect(h.recompile).not.toHaveBeenCalled();
  changed(["edit"], ["edit", "run"]);
  expect(h.recompile).toHaveBeenCalledOnce();
});

test("file changes start no compile while a guest can edit without run", () => {
  h.collab.participants = [{ peer: "g1", role: "guest", caps: ["edit", "run"] }];
  expect(h.gate.fileChangeBlocked()).toBe(false);
  h.collab.participants.push({ peer: "g2", role: "guest", caps: ["edit"] });
  expect(h.gate.fileChangeBlocked()).toBe(true);
});
