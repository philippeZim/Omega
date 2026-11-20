import { describe, expect, test } from "vitest";
import { parseTable, serializeTable } from "./table";

describe("parseTable", () => {
  test("header, alignments and rows", () => {
    const t = parseTable("| a | b | c | d |\n| --- | :-- | --: | :-: |\n| 1 | 2 | 3 | 4 |");
    expect(t.header).toEqual(["a", "b", "c", "d"]);
    expect(t.align).toEqual([null, "left", "right", "center"]);
    expect(t.rows).toEqual([["1", "2", "3", "4"]]);
  });

  test("works without outer pipes and ignores blank lines", () => {
    const t = parseTable("a | b\n---|---\n\n1 | 2\n");
    expect(t.header).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["1", "2"]]);
  });

  test("keeps escaped pipes inside a cell", () => {
    const t = parseTable("| a | b |\n| - | - |\n| x \\| y | z |");
    expect(t.rows[0]).toEqual(["x \\| y", "z"]);
  });

  test("a trailing escaped pipe is cell content, not the row end", () => {
    const t = parseTable("| a | b |\n| - | - |\n| x | y\\|");
    expect(t.rows[0]).toEqual(["x", "y\\|"]);
  });

  test("pads short rows, header and alignments to the widest row", () => {
    const t = parseTable("| a |\n| --- |\n| 1 | 2 | 3 |\n| 4 |");
    expect(t.header).toEqual(["a", "", ""]);
    expect(t.align).toEqual([null, null, null]);
    expect(t.rows).toEqual([["1", "2", "3"], ["4", "", ""]]);
  });

  test("extra alignment cells are cut to the column count", () => {
    expect(parseTable("| a |\n| - | :-: |").align).toEqual([null]);
  });
});

describe("serializeTable", () => {
  test("pads cells to the column width and writes alignment markers", () => {
    const out = serializeTable({
      header: ["name", "n", "c"],
      align: ["left", "right", "center"],
      rows: [["x", "12345", "ab"]],
    });
    expect(out.split("\n")).toEqual([
      "| name |     n |  c  |",
      "| :--- | ----: | :-: |",
      "| x    | 12345 | ab  |",
    ]);
  });

  test("columns are at least 3 wide", () => {
    expect(serializeTable({ header: ["a"], align: [null], rows: [] })).toBe("| a   |\n| --- |");
    expect(serializeTable({ header: [""], align: ["center"], rows: [] })).toBe("|     |\n| :-: |");
  });

  test("width counts code points, not UTF-16 units", () => {
    const out = serializeTable({ header: ["😀😀😀😀"], align: [null], rows: [["äöü"]] });
    expect(out.split("\n")).toEqual(["| 😀😀😀😀 |", "| ---- |", "| äöü  |"]);
  });

  test("round trip is idempotent and preserves content", () => {
    const src = "a|bb|c\n:-|:-:|-:\n1|x \\| y\n|long cell value|2|3|";
    const once = serializeTable(parseTable(src));
    expect(serializeTable(parseTable(once))).toBe(once);
    const t = parseTable(once);
    expect(t.header).toEqual(["a", "bb", "c"]);
    expect(t.align).toEqual(["left", "center", "right"]);
    expect(t.rows).toEqual([["1", "x \\| y", ""], ["long cell value", "2", "3"]]);
  });
});
