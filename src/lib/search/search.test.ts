import { describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async (..._a: unknown[]) => false) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../state.svelte", () => ({ app: { tabs: [], root: null }, openFile: vi.fn() }));
vi.mock("../editor", () => ({ getView: () => null, getText: () => "", replaceDocText: vi.fn() }));
vi.mock("../ui.svelte", () => ({ ui: { confirm, toast: vi.fn() } }));

import { find, replaceAll, replaceInFile } from "./search.svelte";

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

describe("replaceInFile matches like the line-based search", () => {
  async function replaced(text: string, query: string, replacement: string, onlyLine?: number) {
    let out: string | null = null;
    mockIPC((cmd, args) => {
      if (cmd === "read_file") return text;
      if (cmd === "write_file") out = (args as { content: string }).content;
      return null;
    });
    Object.assign(find, { query, replacement, regex: true, wholeWord: false, caseSensitive: true });
    const count = await replaceInFile("/w/a.txt", onlyLine);
    return { count, text: out ?? text };
  }

  it("replaces ^ on every line", async () => {
    expect(await replaced("foo\nfoo\n", "^foo", "X")).toEqual({ count: 2, text: "X\nX\n" });
  });

  it("replaces $ before LF and CRLF and keeps the line endings", async () => {
    expect(await replaced("foo\r\nfoo\nfoo", "foo$", "X")).toEqual({ count: 3, text: "X\r\nX\nX" });
  });

  it("replaces $ on one CRLF line only", async () => {
    expect(await replaced("foo\r\nfoo\r\n", "foo$", "X", 2)).toEqual({ count: 1, text: "foo\r\nX\r\n" });
  });

  it("leaves empty matches alone, which the search doesn't show", async () => {
    expect(await replaced("ab\n", "x*", "-")).toEqual({ count: 0, text: "ab\n" });
    expect(await replaced("aab\n", "a*", "-")).toEqual({ count: 1, text: "-b\n" });
  });

  it("doesn't match across lines", async () => {
    expect(await replaced("a\nb\n", "a\\nb", "X")).toEqual({ count: 0, text: "a\nb\n" });
  });

  it.each([
    ["(a)(b)", "$2$1"], ["(a)(b)", "$&-$&"], ["(a)(b)", "$$1"], ["(a)", "$1$2"], ["(a)", "$12"], ["(a)", "$01"], ["(a)", "$00"], ["(a)", "$0"],
    ["(a)|(z)", "[$2]"], ["(?<x>a)(?<y>b)", "$<y>$<x>"], ["(?<x>a)", "$<nope>|$<x"], ["(a)", "$<x>"], ["b", "$`|$'"], ["a", "$"], ["a", "$x $"],
    ["(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)", "$10$1$11"], ["(?<x>a)", "$1$&$`$'$$"],
  ])("expands %s -> %s like the native replace", async (query, replacement) => {
    const line = "xabcdefghijy abcdefghij z";
    const native = line.replace(new RegExp(query, "gu"), replacement);
    expect((await replaced(line, query, replacement)).text).toBe(native);
  });

  it("expands groups and the line context per match", async () => {
    expect(await replaced("ab ab\nab\n", "(a)(b)", "$2$1")).toEqual({ count: 3, text: "ba ba\nba\n" });
    expect(await replaced("xay\nz\n", "a", "[$`|$']")).toEqual({ count: 1, text: "x[x|y]y\nz\n" });
  });
});
