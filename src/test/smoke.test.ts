import { expect, test } from "vitest";
import { invoke } from "@tauri-apps/api/core";

test("tauri IPC is mocked", async () => {
  expect(await invoke("anything")).toBeNull();
  localStorage.setItem("a", "1");
  expect(localStorage.getItem("a")).toBe("1");
});
