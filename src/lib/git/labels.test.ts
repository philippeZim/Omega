import { describe, expect, test } from "vitest";
import { aheadLabel } from "./labels";

describe("aheadLabel (#76)", () => {
  test("singular for one commit, plural otherwise", () => {
    expect(aheadLabel(1)).toBe(" (1 commit)");
    expect(aheadLabel(2)).toBe(" (2 commits)");
  });
});
