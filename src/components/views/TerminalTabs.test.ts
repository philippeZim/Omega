import { expect, test, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";

const { tabs } = vi.hoisted(() => ({ tabs: ["t1", "t2", "t3", "t4", "t5"].map((id, i) => ({ id, title: `Terminal ${i + 1}`, kind: "shell", exited: false, status: null })) }));
vi.mock("../../lib/state.svelte", () => ({ app: { root: null } }));
vi.mock("../../lib/terminal.svelte", () => ({
  terms: { tabs, active: "t5", split: false },
  newTerminal: vi.fn(), closeTerminal: vi.fn(), focusTerm: vi.fn(), listShells: vi.fn(async () => []), shellPref: { id: "" }, setDefaultShell: vi.fn(), toggleSplit: vi.fn(),
}));

import TerminalTabs from "./TerminalTabs.svelte";

test("the active terminal tab is scrolled into view (#86)", () => {
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.getAttribute("data-term") ?? ""); };
  const target = document.createElement("div");
  const c = mount(TerminalTabs, { target });
  flushSync();
  expect(scrolled).toContain("t5");
  unmount(c);
});
