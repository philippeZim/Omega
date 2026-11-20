import { expect, test } from "vitest";
import { Text } from "@codemirror/state";
import { computeChunks } from "./gutter";

test("scattered edits in a large file give one marker range per changed line (#139)", () => {
  // Every 7th line of 20000 changed: the old scanLimit 5000 gave up and returned one block.
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i + 1}`);
  const head = Text.of(lines);
  const doc = Text.of(lines.map((l, i) => ((i + 1) % 7 === 0 ? l + " CHANGED" : l)));
  const chunks = computeChunks(head, doc);
  expect(chunks.length).toBe(Math.floor(20000 / 7));
  expect(doc.lineAt(chunks[0].fromB).number).toBe(7);
  expect(doc.lineAt(chunks[1].fromB).number).toBe(14);
});

test("no HEAD version: no markers", () => {
  expect(computeChunks(null, Text.of(["a"]))).toEqual([]);
});
