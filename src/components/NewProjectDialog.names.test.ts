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

function setName(target: HTMLElement, value: string) {
  const input = target.querySelector<HTMLInputElement>("label input:not([readonly])")!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function pick(target: HTMLElement, label: string) {
  [...target.querySelectorAll<HTMLButtonElement>(".tpl")].find((b) => b.querySelector(".name")!.textContent === label)!.click();
  flushSync();
}

const create = (target: HTMLElement) => target.querySelector<HTMLButtonElement>(".btn.primary")!;
const hint = (target: HTMLElement) => target.querySelector<HTMLElement>(".hint")!;

test("an invalid project name explains why Create is disabled (#85)", () => {
  const target = open();
  pick(target, "Rust");
  setName(target, "mein Projekt");
  expect(create(target).disabled).toBe(true);
  expect(hint(target).classList.contains("err")).toBe(true);
  expect(hint(target).textContent).toMatch(/letters, digits/);

  setName(target, "my_project");
  expect(create(target).disabled).toBe(false);
  expect(hint(target).classList.contains("err")).toBe(false);
  expect(hint(target).textContent).toContain("Will be created in");
  expect(hint(target).textContent).toContain("/home/me/my_project");
});

test("a plain folder accepts spaces but not path characters (#85)", () => {
  const target = open();
  pick(target, "Empty");
  setName(target, "mein Projekt");
  expect(create(target).disabled).toBe(false);
  expect(hint(target).textContent).toContain("/home/me/mein Projekt");
  setName(target, "a/b");
  expect(create(target).disabled).toBe(true);
  expect(hint(target).classList.contains("err")).toBe(true);
});
