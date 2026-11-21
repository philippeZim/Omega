import { afterEach, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

const h = vi.hoisted(() => ({ runner: null as unknown as { newProject: boolean } }));

vi.mock("../lib/native", () => ({ openDialog: vi.fn() }));
vi.mock("../lib/git/git.svelte", () => ({ cloneInto: vi.fn(), cloneTabRequested: { value: false } }));
vi.mock("../lib/state.svelte", () => ({ app: { root: "/home/me/proj" } }));
vi.mock("../lib/code/runner.svelte", async () => {
  const { reactive } = await import("../test/reactive.svelte");
  h.runner = reactive({ newProject: false });
  return { runner: h.runner, createProject: vi.fn() };
});

import NewProjectDialog from "./NewProjectDialog.svelte";

let c: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (c) unmount(c);
  c = null;
  document.body.innerHTML = "";
});

function open() {
  const target = document.createElement("div");
  document.body.append(target);
  c = mount(NewProjectDialog, { target });
  h.runner.newProject = true;
  flushSync();
  return target;
}

test("Escape closes the dialog even when the focus is outside it (#84)", () => {
  const target = open();
  expect(target.querySelector(".sheet")).not.toBeNull();
  (document.activeElement as HTMLElement | null)?.blur();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(h.runner.newProject).toBe(false);
  expect(target.querySelector(".sheet")).toBeNull();
});

test("opening the dialog focuses the name field (#84)", () => {
  const target = open();
  const input = target.querySelector<HTMLInputElement>("input:not([readonly])");
  expect(document.activeElement).toBe(input);
});
