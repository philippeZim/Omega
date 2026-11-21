import { describe, expect, test } from "vitest";
import { findHeadingLine, headingSlug } from "./headingAnchor";

describe("heading anchors (#42)", () => {
  test("slugs like GitHub", () => {
    expect(headingSlug("Sec two")).toBe("sec-two");
    expect(headingSlug("What's new?  (v2)")).toBe("whats-new--v2");
    expect(headingSlug("Über uns")).toBe("über-uns");
  });

  test("finds ATX and setext headings, skips code fences, numbers duplicates", () => {
    const text = ["# T", "", "## Sec two", "```", "# not a heading", "```", "Setext", "---", "## Sec two ##", "**Bold** `x`"].join("\n");
    expect(findHeadingLine(text, "t")).toBe(0);
    expect(findHeadingLine(text, "sec-two")).toBe(2);
    expect(findHeadingLine(text, "not-a-heading")).toBe(-1);
    expect(findHeadingLine(text, "setext")).toBe(6);
    expect(findHeadingLine(text, "sec-two-1")).toBe(8);
    expect(findHeadingLine(text, "Sec-Two")).toBe(2);
    expect(findHeadingLine("## %C3%9Cber", "%C3%9Cber")).toBe(-1);
    expect(findHeadingLine("## Über", "%C3%9Cber")).toBe(0);
  });
});
