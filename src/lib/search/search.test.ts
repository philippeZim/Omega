import { describe, expect, it, vi } from "vitest";

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async (..._a: unknown[]) => false) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../state.svelte", () => ({ app: { tabs: [], root: null }, openFile: vi.fn() }));
vi.mock("../editor", () => ({ getView: () => null, getText: () => "", replaceDocText: vi.fn() }));
vi.mock("../ui.svelte", () => ({ ui: { confirm, toast: vi.fn() } }));

import { find, replaceAll } from "./search.svelte";

describe("replaceAll", () => {
  it("says 5000+ in the confirmation when the result list is capped", async () => {
    find.hits = [{ file: "/w/big.log", line: 1, ranges: [[0, 5]], text: "line 1" }];
    find.total = 5000;
    find.truncated = true;
    find.replacement = "L ";
    await replaceAll();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][1]).toContain("5000+");
  });
});
