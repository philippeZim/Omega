import { describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

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

describe("replaceAll with a capped result list", () => {
  it("replaces in every file with a match, also those after the cap", async () => {
    const written: string[] = [];
    mockIPC((cmd, args) => {
      const a = args as Record<string, unknown>;
      if (cmd === "search_files") return ["/w/big.log", "/w/late.txt"];
      if (cmd === "read_file") return "line 1\n";
      if (cmd === "write_file") written.push(a.path as string);
      return null;
    });
    confirm.mockResolvedValueOnce(true);
    find.query = "line ";
    find.hits = [{ file: "/w/big.log", line: 1, ranges: [[0, 5]], text: "line 1" }];
    find.total = 5000;
    find.truncated = true;
    find.folder = "/w";
    find.scope = "folder";
    find.replacement = "L ";
    vi.useFakeTimers(); // keep the follow-up search (runSearch) from firing after the test
    await replaceAll();
    vi.clearAllTimers();
    vi.useRealTimers();
    expect(confirm.mock.lastCall?.[1]).toContain("2 files");
    expect(written.sort()).toEqual(["/w/big.log", "/w/late.txt"]);
  });
});
