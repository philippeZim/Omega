// Code Together session state (collab.svelte.ts) with the transport events mocked.
import { expect, test } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

const NAME = "Gäste-Testerin Ümlaut mit sehr langem Namen"; // 43 characters

test("a guest with a long name finds itself in the participant list (#130)", async () => {
  mockIPC((cmd) => (cmd === "collab_join" ? "hostpeer" : null), { shouldMockEvents: true });
  const { collab, join, isMe, setMyName, MAX_NAME } = await import("./collab.svelte");
  setMyName(NAME);
  expect(collab.me.name).toBe(NAME.slice(0, MAX_NAME));
  await join("omega-ticket");

  // The host's list: another guest with the same (cut) name, and me.
  const cut = NAME.slice(0, 40);
  const participants = [
    { peer: "host", name: "Host", color: "#111111", role: "host" },
    { peer: "other", name: cut, color: "#222222", role: "guest" },
    { peer: "me123", name: cut, color: "#333333", role: "guest" },
  ];
  await emit("collab-msg", { peer: "hostpeer", msg: JSON.stringify({ t: "welcome", you: { peer: "me123", name: cut, color: "#333333" }, participants }) });
  expect(collab.status).toBe("connected");
  expect(collab.participants.filter(isMe).map((p) => p.peer)).toEqual(["me123"]);
});
