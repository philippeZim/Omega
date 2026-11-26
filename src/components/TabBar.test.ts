// #117: the tab bar scrolls the active tab into view when the tabs overflow.
import { afterEach, expect, test, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.mock("../lib/state.svelte", async () => ({
  app: (await import("./TabBar.fixture.svelte")).app,
  activateIn: vi.fn(),
  closeInGroup: vi.fn(),
  newFileInSession: vi.fn(),
  foreignProject: () => null,
  focusGroup: vi.fn(),
  groupMode: () => null,
  groupCount: () => 1,
  setMode: vi.fn(),
  splitGroup: vi.fn(),
  joinGroups: vi.fn(),
}));
vi.mock("./RunBar.svelte", () => ({ default: () => {} }));
vi.mock("../lib/commands.svelte", () => ({ shortcutLabel: () => "Ctrl W", withShortcut: (s: string) => s }));
vi.mock("./LangPicker.svelte", () => ({ default: () => {} }));

const { app } = await import("./TabBar.fixture.svelte");
const { default: TabBar } = await import("./TabBar.svelte");

let cmp: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
});

test("the active tab is scrolled into view (#117)", async () => {
  const scrolled: string[] = [];
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
    scrolled.push(this.querySelector(".name")?.textContent ?? "");
  });
  app.tabs = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, path: `/p/f${i}.txt`, name: `f${i}.txt`, dirty: false }));
  const g = app.groups.groups.main;
  const show = (id: string) => {
    if (!g.tabs.includes(id)) g.tabs.push(id);
    g.active = app.activeId = id;
  };
  g.tabs = app.tabs.map((x) => x.id);
  show("t0");
  cmp = mount(TabBar, { target: document.body, props: { gid: "main" } });
  flushSync();
  await tick();
  scrolled.length = 0;
  app.tabs.push({ id: "t8", path: "/p/code.py", name: "code.py", dirty: false });
  show("t8");
  flushSync();
  await tick();
  await tick();
  expect(scrolled).toContain("code.py");
  show("t3");
  flushSync();
  await tick();
  await tick();
  expect(scrolled.at(-1)).toBe("f3.txt");
});
