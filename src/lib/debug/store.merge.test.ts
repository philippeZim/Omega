import { describe, expect, it } from "vitest";
import { mergeBreakpoints } from "./store.svelte";

describe("breakpoints with several windows", () => {
  it("a save keeps what another window set meanwhile", () => {
    const base = { "/a.py": [{ line: 1 }] };
    const stored = { "/a.py": [{ line: 1 }], "/b.py": [{ line: 7 }] };
    const mine = { "/a.py": [{ line: 1 }, { line: 2 }] };
    expect(mergeBreakpoints(stored, base, mine)).toEqual({ "/a.py": [{ line: 1 }, { line: 2 }], "/b.py": [{ line: 7 }] });
  });

  it("a removal in this window stays removed", () => {
    const base = { "/a.py": [{ line: 1 }], "/b.py": [{ line: 2 }] };
    expect(mergeBreakpoints(base, base, { "/b.py": [{ line: 2 }] })).toEqual({ "/b.py": [{ line: 2 }] });
  });
});
