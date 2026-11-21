import { describe, expect, test } from "vitest";

// Vitest stubs every .css import (even ?raw) to "", so read the files through Node (no @types/node here).
type Fs = { readFileSync(path: string, enc: "utf8"): string };
const proc = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = proc.getBuiltinModule("node:fs") as Fs;
const read = (path: string) => fs.readFileSync(`${proc.cwd()}/src/${path}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Keyframes that run on or inside glass panels.
const onGlass = [
  "app.css",
  "components/views/TerminalTabs.svelte",
  "components/DebugPanel.svelte",
  "components/LspStatus.svelte",
  "components/KeybindingEditor.svelte",
  "components/CollabPanel.svelte",
  "components/ToolProgress.svelte",
  "components/PdfPanel.svelte",
];

function keyframes(source: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  for (const m of source.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    found.push({ name: m[1], body: source.slice(start, i - 1) });
  }
  return found;
}

// A rule's declarations, for every selector list that names exactly this selector.
function declarations(source: string, selector: string): string {
  const out: string[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").some((s) => s.trim() === selector)) out.push(m[2]);
  }
  return out.join("\n");
}

describe("no transform or opacity animation on glass (#151)", () => {
  test.each(onGlass)("%s: keyframes leave transform and opacity alone", (file) => {
    for (const { name, body } of keyframes(read(file))) {
      expect(body, `${file} @keyframes ${name}`).not.toMatch(/(^|[\s;{])(transform|opacity)\s*:/);
    }
  });

  test.each([
    ".gbtn:hover:not(:disabled)",
    ".gbtn:active:not(:disabled)",
    ".gbtn.run:hover:not(:disabled) svg",
    ".gbtn.stop:hover:not(:disabled) svg",
  ])("%s does not move the button", (selector) => {
    const rule = declarations(read("app.css"), selector);
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/transform\s*:/);
  });

  test(".gbtn glow does not fade through opacity", () => {
    expect(declarations(read("app.css"), ".gbtn::before")).not.toMatch(/transition[^;]*opacity/);
  });
});
