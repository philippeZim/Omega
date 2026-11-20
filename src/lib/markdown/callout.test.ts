import { describe, expect, test } from "vitest";
import { canonicalType, parseCalloutHead } from "./callout";

describe("canonicalType", () => {
  test("canonical names and aliases, case-insensitive", () => {
    expect(canonicalType("tip")).toBe("tip");
    expect(canonicalType("HINT")).toBe("tip");
    expect(canonicalType("tldr")).toBe("abstract");
    expect(canonicalType("Error")).toBe("danger");
    expect(canonicalType("cite")).toBe("quote");
  });
  test("unknown types render as note", () => {
    expect(canonicalType("whatever")).toBe("note");
    expect(canonicalType("")).toBe("note");
  });
});

describe("parseCalloutHead", () => {
  test("type, title and offsets", () => {
    const line = "> [!Warning] Be careful";
    const h = parseCalloutHead(line)!;
    expect(h).toMatchObject({ type: "warning", raw: "Warning", fold: "", title: "Be careful" });
    expect(line.slice(h.markerFrom, h.markerTo)).toBe("[!Warning] ");
    expect(h.foldAt).toBe(line.indexOf("]") + 1);
  });

  test("fold markers", () => {
    const line = ">[!faq]- Title ";
    const h = parseCalloutHead(line)!;
    expect(h).toMatchObject({ type: "question", fold: "-", title: "Title" });
    expect(line[h.foldAt]).toBe("-");
    expect(line.slice(h.markerFrom, h.markerTo)).toBe("[!faq]- ");
    expect(parseCalloutHead("> [!tip]+")).toMatchObject({ fold: "+", title: "" });
  });

  test("indented quote, unknown type with dashes", () => {
    const h = parseCalloutHead("  > [!my-type]")!;
    expect(h).toMatchObject({ type: "note", raw: "my-type", markerFrom: 4, title: "" });
  });

  test("not a callout", () => {
    expect(parseCalloutHead("[!tip] no quote")).toBeNull();
    expect(parseCalloutHead("> just a quote")).toBeNull();
    expect(parseCalloutHead("> [!] empty")).toBeNull();
    expect(parseCalloutHead(">  [!tip] two spaces")).toBeNull();
  });
});
