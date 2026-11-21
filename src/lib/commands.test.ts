import { beforeEach, describe, expect, test, vi } from "vitest";
import { KEYMAPS } from "./keymaps";
import { formatKey, normalize } from "./keys";
import { dictionaries } from "./i18n/strings";
import { COMMANDS, applyKeymap, conflicts, defaultKeysFor, handleGlobalKey, keymapState, keysFor, modeNames, modeSwitchLabel, resetAllKeys, setKeys, shortcutLabel, withShortcut } from "./commands.svelte";
import { toggleZone } from "./layout.svelte";
import { settings } from "./settings.svelte";
const { stub } = vi.hoisted(() => {
  const stub = (extra: Record<string, unknown> = {}) =>
    new Proxy(extra, {
      get: (t, k) => (k in t ? t[k as string] : k === "then" || typeof k === "symbol" ? undefined : (t[k as string] = vi.fn())),
      has: () => true,
    });
  return { stub };
});
vi.mock("./state.svelte", () => stub({ app: { mode: "text" } }));
vi.mock("./ui.svelte", () => stub({ ui: { dialog: null, toast: vi.fn() } }));
vi.mock("./updater.svelte", () => stub());
vi.mock("./report.svelte", () => stub());
vi.mock("./settings.svelte", () => stub());
vi.mock("./code/runner.svelte", () => stub());
vi.mock("./code/langMenu", () => stub());
vi.mock("./debug/debugger.svelte", () => stub());
vi.mock("./debug/store.svelte", () => stub({ dbg: { status: "idle" } }));
vi.mock("./terminal.svelte", () => stub());
vi.mock("./layout.svelte", () => stub());
vi.mock("./latex/controller.svelte", () => stub());
vi.mock("./search/search.svelte", () => stub());
vi.mock("./collab/collab.svelte", () => stub({ collab: { requests: [], role: null } }));
vi.mock("./git/git.svelte", () => stub());
vi.mock("./git/blame.svelte", () => stub());
vi.mock("./editor", () => stub());

const ids = COMMANDS.map((c) => c.id);
const en = dictionaries.en as Record<string, string>;

describe("command registry integrity", () => {
  test("command ids are unique", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("keymap preset ids are unique", () => {
    expect(new Set(KEYMAPS.map((k) => k.id)).size).toBe(KEYMAPS.length);
  });

  test.each(KEYMAPS.map((k) => [k.id, k] as const))("every command in preset %s exists", (_, k) => {
    expect(Object.keys(k.keys).filter((id) => !ids.includes(id))).toEqual([]);
  });

  test("every command has a translated label and group", () => {
    for (const c of COMMANDS) {
      expect(en[`commands.cmd.${c.id}`], c.id).toBeTruthy();
      expect(c.label).toBe(en[`commands.cmd.${c.id}`]);
      expect(c.group).not.toMatch(/^commands\.group\./);
    }
  });

  test("default and preset bindings are well-formed", () => {
    const all = [...COMMANDS.flatMap((c) => c.keys), ...KEYMAPS.flatMap((k) => Object.values(k.keys).flat())];
    for (const k of all) {
      expect(k, k).toMatch(/^((Mod|Ctrl|Meta|Alt|Shift)-)*[^-]+$/);
      expect(normalize(normalize(k))).toBe(normalize(k));
    }
  });
});

describe("presets and overrides", () => {
  beforeEach(() => {
    applyKeymap("omega", false);
    resetAllKeys();
  });

  test("Omega defaults, normalized", () => {
    expect(keysFor("editor.selectLine")).toEqual(["Mod-l"]);
    expect(keysFor("editor.cursorsAtLineEnds")).toEqual(["Alt-Shift-i"]);
    expect(keysFor("nope")).toEqual([]);
  });

  test("a preset's own entries replace the defaults", () => {
    applyKeymap("vscode", false);
    expect(keymapState.preset).toBe("vscode");
    expect(localStorage.getItem("keymap.preset")).toBe("vscode");
    expect(keysFor("search.actions")).toEqual(["Mod-Shift-p", "F1"]);
    expect(keysFor("app.help")).toEqual([]);
    for (const [id, keys] of Object.entries(KEYMAPS.find((k) => k.id === "vscode")!.keys)) expect(defaultKeysFor(id)).toEqual(keys.map(normalize));
  });

  test("keys a preset gives to another command are dropped (modes overlap)", () => {
    // VS Code: Mod-Shift-h is Replace in Files, so Markdown highlight loses it.
    expect(keysFor("md.highlight")).toEqual(["Mod-Shift-h"]);
    applyKeymap("vscode", false);
    expect(keysFor("md.highlight")).toEqual([]);
  });

  test("…but kept when the modes do not overlap", () => {
    // JetBrains: Mod-b is Go to Definition in Code mode only; Markdown bold keeps it.
    applyKeymap("jetbrains", false);
    expect(keysFor("lsp.gotoDefinition")).toContain("Mod-b");
    expect(keysFor("md.bold")).toEqual(["Mod-b"]);
  });

  test("setKeys overrides and persists; null resets", () => {
    setKeys("editor.selectLine", ["Ctrl-Shift-L"]);
    expect(keysFor("editor.selectLine")).toEqual(["Mod-Shift-l"]);
    expect(JSON.parse(localStorage.getItem("keybindings")!)).toEqual({ "editor.selectLine": ["Mod-Shift-l"] });
    expect(defaultKeysFor("editor.selectLine")).toEqual(["Mod-l"]);
    setKeys("editor.selectLine", null);
    expect(keysFor("editor.selectLine")).toEqual(["Mod-l"]);
    expect(localStorage.getItem("keybindings")).toBeNull();
  });

  test("an empty override unbinds", () => {
    setKeys("file.save", []);
    expect(keysFor("file.save")).toEqual([]);
  });

  test("applyKeymap(keepCustom) drops overrides that equal the new preset", () => {
    setKeys("search.actions", ["F1", "Mod-Shift-p"]); // same as VS Code's, other order
    setKeys("file.save", ["F2"]);
    applyKeymap("vscode", true);
    expect(keymapState.overrides).toEqual({ "file.save": ["F2"] });
    applyKeymap("omega", false);
    expect(keymapState.overrides).toEqual({});
    expect(localStorage.getItem("keybindings")).toBeNull();
  });

  test("conflicts respects modes", () => {
    const c = (id: string, k: string) => conflicts(id, k).map((x) => x.id);
    expect(c("app.sidebar", "Mod-b")).toContain("md.bold");
    expect(c("md.bold", "Mod-b")).toEqual(["app.sidebar"]);
    expect(c("view.outline", "Ctrl-B")).toEqual(["app.sidebar"]); // latex-only: no clash with markdown bold
    expect(c("app.sidebar", "F24")).toEqual([]);
  });
});

describe("handleGlobalKey", () => {
  beforeEach(() => {
    applyKeymap("omega", false);
    resetAllKeys();
  });

  test("runs the matching app command and prevents the default", () => {
    const e = new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, cancelable: true });
    handleGlobalKey(e);
    expect(toggleZone).toHaveBeenCalledWith("left");
    expect(e.defaultPrevented).toBe(true);
  });

  test("an overridden key no longer triggers the old binding", () => {
    setKeys("app.sidebar", ["Mod-Shift-F12"]);
    handleGlobalKey(new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, cancelable: true }));
    expect(toggleZone).not.toHaveBeenCalled();
  });

  test("Ctrl+, opens Settings by the produced character, wherever ',' sits (AZERTY: KeyM)", () => {
    const e = new KeyboardEvent("keydown", { key: ",", code: "KeyM", ctrlKey: true, cancelable: true });
    handleGlobalKey(e);
    expect(e.defaultPrevented).toBe(true);
    expect((settings as unknown as { open: boolean }).open).toBe(true);
  });

  test("blocks reload (F5) when no command matches", () => {
    setKeys("debug.continue", []);
    const e = new KeyboardEvent("keydown", { key: "F5", code: "F5", cancelable: true });
    handleGlobalKey(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("modeNames", () => {
  test("shows mode display names, not raw ids", () => {
    expect(modeNames(["latex"])).toBe("LaTeX");
    expect(modeNames(["code", "markdown"])).toBe("Code, Markdown");
    expect(modeNames(undefined)).toBe("");
  });
});

describe("shortcutLabel / withShortcut", () => {
  beforeEach(() => {
    applyKeymap("omega", false);
    resetAllKeys();
  });

  test("follow custom bindings instead of the defaults", () => {
    setKeys("mode.text", ["Mod-1", "Mod-2"]);
    setKeys("mode.markdown", []);
    expect(shortcutLabel("mode.text")).toBe(`${formatKey("Mod-1")} / ${formatKey("Mod-2")}`);
    expect(shortcutLabel("mode.markdown")).toBe("");
    expect(withShortcut("Markdown", "mode.markdown")).toBe("Markdown");
    expect(withShortcut("Sidebar", "app.sidebar")).toBe(`Sidebar (${formatKey("Mod-b")})`);
  });
});

describe("modeSwitchLabel (#140)", () => {
  beforeEach(() => {
    applyKeymap("omega", false);
    resetAllKeys();
  });

  test("compact for the usual run, each key otherwise, empty when unbound", () => {
    expect(modeSwitchLabel()).toBe(`${formatKey("Mod-1")} – 4`);
    setKeys("mode.latex", ["Alt-F3"]);
    expect(modeSwitchLabel()).toBe(["Mod-1", "Mod-2", "Alt-F3", "Mod-4"].map(formatKey).join(" / "));
    for (const m of ["text", "markdown", "latex", "code"]) setKeys(`mode.${m}`, []);
    expect(modeSwitchLabel()).toBe("");
  });
});

describe("guest session guards", () => {
  test("hosting or joining while a guest is blocked", async () => {
    const { guestGuard } = await import("./collab/guard");
    const c = await import("./collab/collab.svelte");
    guestGuard.status = () => "connected";
    COMMANDS.find((x) => x.id === "collab.host")!.run();
    COMMANDS.find((x) => x.id === "collab.join")!.run();
    guestGuard.status = () => "none";
    expect(c.startHosting).not.toHaveBeenCalled();
    expect(c.joinFromClipboard).not.toHaveBeenCalled();
  });

  test("hosting again or joining while hosting is blocked", async () => {
    const { guestGuard } = await import("./collab/guard");
    const c = await import("./collab/collab.svelte");
    const { ui } = await import("./ui.svelte");
    vi.mocked(ui.toast).mockClear();
    guestGuard.hosting = () => true;
    COMMANDS.find((x) => x.id === "collab.host")!.run();
    COMMANDS.find((x) => x.id === "collab.join")!.run();
    guestGuard.hosting = () => false;
    expect(c.startHosting).not.toHaveBeenCalled();
    expect(c.joinFromClipboard).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledTimes(2);
  });
});
