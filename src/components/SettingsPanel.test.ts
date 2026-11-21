import { describe, expect, test } from "vitest";
import src from "./SettingsPanel.svelte?raw";

// #62: screen readers only announced "slider" for the size steppers and nothing for the port field.
describe("SettingsPanel markup", () => {
  test("every input has an accessible label", () => {
    const inputs = src.match(/<input\b[\s\S]*?\/>/g) ?? [];
    expect(inputs.length).toBeGreaterThan(0);
    for (const tag of inputs) expect(tag, tag).toMatch(/aria-label(ledby)?=/);
  });
});
