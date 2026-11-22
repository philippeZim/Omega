import { beforeEach, describe, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({
  st: { status: null as string | null, message: undefined as string | undefined },
  lang: null as { id: string; label: string; server?: string } | null,
  restart: vi.fn(),
  active: null as { path: string; large?: boolean } | null,
  toast: vi.fn(),
  menu: vi.fn(),
}));

vi.mock("../state.svelte", () => ({ app: { tabs: [] }, activeTab: () => m.active, isRemotePath: () => false }));
vi.mock("../editor", () => ({ refreshLanguage: () => {} }));
vi.mock("../ui.svelte", () => ({ ui: { openMenu: m.menu, toast: m.toast } }));
vi.mock("./lsp.svelte", () => ({ closeLspDoc: () => {}, statusFor: () => m.st }));
vi.mock("./lspExtension", () => ({ restartLanguageServer: m.restart }));
vi.mock("./langOverride.svelte", () => ({
  effectiveLang: () => m.lang,
  onLanguageOverride: () => {},
  overrideFor: () => null,
  setLanguageOverride: async () => {},
}));

import { languageMenuItems, openLanguageMenu } from "./langMenu";

const python = { id: "python", label: "Python", server: "python" };

beforeEach(() => {
  m.st = { status: null, message: undefined };
  m.lang = python;
  m.restart.mockClear();
});

describe("language menu", () => {
  test("a running server shows its status and a restart above the languages", () => {
    m.st = { status: "ready", message: undefined };
    const items = languageMenuItems("/w/a.py");
    expect(items[0]).toMatchObject({ label: "Language server running", info: { status: "ready" } });
    expect(items[1].label).toContain("Restart language server");
    expect(items[2].separator).toBe(true);
    expect(items[3].label).toBe("Automatic (Python)");
    items[1].action!();
    expect(m.restart).toHaveBeenCalledWith(python, "/w/a.py");
  });

  test("a missing server offers the install", () => {
    m.st = { status: "missing", message: undefined };
    expect(languageMenuItems("/w/a.py")[1].label).toContain("Install language server");
  });

  test.each(["starting", "installing"])("no action while %s", (status) => {
    m.st = { status, message: undefined };
    const items = languageMenuItems("/w/a.py");
    expect(items[0].info?.status).toBe(status);
    expect(items[1].separator).toBe(true);
  });

  test("keeps the server's message, such as why it is paused", () => {
    m.st = { status: "stopped", message: "  Metals is paused \n" };
    expect(languageMenuItems("/w/a.scala")[0].info?.message).toBe("Metals is paused");
  });

  test("a language without a server has no section and no stray separator", () => {
    m.lang = { id: "json", label: "JSON" };
    const items = languageMenuItems("/w/a.json");
    expect(items[0].label).toContain("Automatic");
    expect(items.some((i) => i.info)).toBe(false);
    expect(items.filter((i) => i.separator)).toHaveLength(1);
  });
});

test("a large file: the menu says why instead of offering languages (#174)", () => {
  m.active = { path: "/p/big.py", large: true };
  openLanguageMenu();
  m.active = null;
  expect(m.menu).not.toHaveBeenCalled();
  expect(m.toast).toHaveBeenCalledTimes(1);
});

