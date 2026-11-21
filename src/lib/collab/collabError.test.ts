// #132: Code Together errors from the backend come as codes and are shown in the UI language.
import { afterEach, expect, test } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { collabErrorText } from "./collabError";
import { setLocale } from "../i18n/index.svelte";

afterEach(() => setLocale("en"));

test("codes become translated messages", () => {
  setLocale("en");
  expect(collabErrorText("collab:invalid_ticket")).toBe("Invalid invite code");
  expect(collabErrorText("collab:connect_failed:no route")).toBe("Connection failed: no route");
  setLocale("de");
  expect(collabErrorText("collab:invalid_ticket")).toBe("Ungültiger Einladungscode");
  setLocale("fr");
  expect(collabErrorText("collab:timeout")).toBe("Délai dépassé – l’hôte est injoignable");
});

test("other errors pass through unchanged", () => {
  expect(collabErrorText("Address in use")).toBe("Address in use");
  expect(collabErrorText("collab:unknown")).toBe("collab:unknown");
});

test("joining with a bad invite code shows the error in the UI language", async () => {
  setLocale("en");
  mockIPC((cmd) => (cmd === "collab_join" ? Promise.reject("collab:invalid_ticket") : null), { shouldMockEvents: true });
  const { collab, join } = await import("./collab.svelte");
  collab.me.name = "Me";
  await join("hello world");
  expect(collab.error).toBe("Invalid invite code");
  expect(collab.status).toBe("error");
});
