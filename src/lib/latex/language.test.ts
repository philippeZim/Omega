import { describe, expect, test } from "vitest";
import { outline } from "./language";

describe("latex outline", () => {
  test("levels, titles, lines and positions", () => {
    const text = "\\documentclass{book}\n\\part{P}\n\\chapter{C}\n  \\section{S}\n\\subsection*{Sub}\n\\subsubsection[short]{Long}\n\\paragraph{Para}";
    const o = outline(text);
    expect(o.map((i) => [i.level, i.title, i.line])).toEqual([
      [0, "P", 2],
      [1, "C", 3],
      [2, "S", 4],
      [3, "Sub", 5],
      [4, "Long", 6],
      [5, "Para", 7],
    ]);
    for (const i of o) expect(text.startsWith("\\", i.pos)).toBe(true);
    expect(text.slice(o[2].pos, o[2].pos + 8)).toBe("\\section");
  });

  test("ignores commented-out headings", () => {
    expect(outline("% \\section{Hidden}\ntext % \\section{Also}\n\\section{Shown}").map((i) => i.title)).toEqual(["Shown"]);
  });

  test("empty title gets a placeholder", () => {
    const [i] = outline("\\section{  }");
    expect(i.title).not.toBe("");
    expect(i.title.trim()).toBe(i.title);
  });

  test("multiple headings on one line", () => {
    // Only the first per line: the regex is anchored to the line start.
    expect(outline("\\section{A} \\section{B}").map((i) => i.title)).toEqual(["A"]);
  });

  test("no headings → []", () => {
    expect(outline("Hello \\textbf{world}")).toEqual([]);
  });

  test("titles with nested braces are complete", () => {
    expect(outline("\\section{Intro to \\LaTeX{} and \\emph{more}}")[0].title).toBe("Intro to \\LaTeX{} and \\emph{more}");
    expect(outline("\\section{a \\} b}")[0].title).toBe("a \\} b");
    expect(outline("\\section{Open\n\nnot closed}")).toEqual([]);
    expect(outline("\\section{Open\r\n\r\nnot closed}")).toEqual([]);
    expect(outline("\\section{Open\n  \t\nnot closed}")).toEqual([]);
    expect(outline("\\section{Two\n lines}")[0].title).toBe("Two\n lines");
  });
});
