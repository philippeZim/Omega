import { expect, test, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";

vi.mock("../lib/state.svelte", () => ({ openFile: async () => {} }));
vi.mock("../lib/editor", () => ({ getView: () => null }));
vi.mock("../lib/debug/debugger.svelte", () => ({ stopReasonLabel: (r: string) => r, selectFrame: () => {}, toggleNode: () => {}, inProject: () => true }));

import DebugPanel from "./DebugPanel.svelte";
import { dbg } from "../lib/debug/store.svelte";

test("call stack frames carry the full name as tooltip (#105)", () => {
  const long = "std::panicking::catch_unwind::do_call::<std::rt::lang_start_internal::{{closure}}>";
  dbg.status = "stopped";
  dbg.frames = [
    { id: 1, name: long, path: null, line: 0, column: 0, subtle: true },
    { id: 2, name: "main", path: "/p/src/main.rs", line: 8, column: 1, subtle: false },
  ];
  const target = document.createElement("div");
  const c = mount(DebugPanel, { target });
  flushSync();
  const frames = target.querySelectorAll<HTMLElement>(".frame");
  expect(frames[0].getAttribute("title")).toBe(long);
  expect(frames[1].getAttribute("title")).toBe("main · /p/src/main.rs:8");
  unmount(c);
});
