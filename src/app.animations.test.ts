// @ts-ignore -- the project has no @types/node; this test only runs under Node.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Vitest stubs every .css import (even ?raw) to "", so the files are read from disk.
const read = (path: string) => (readFileSync(`src/${path}`, "utf8") as string).replace(/\/\*[\s\S]*?\*\//g, "");

// Files whose styles run on or inside glass panels.
const onGlass = [
  "app.css",
  "lib/markdown/markdown.css",
  "components/views/TerminalTabs.svelte",
  "components/ChangesPanel.svelte",
  "components/CollabPanel.svelte",
  "components/CommandPalette.svelte",
  "components/DebugPanel.svelte",
  "components/DiffView.svelte",
  "components/DockZone.svelte",
  "components/FileViewer.svelte",
  "components/ImageView.svelte",
  "components/PdfView.svelte",
  "components/FindInFiles.svelte",
  "components/KeybindingEditor.svelte",
  "components/LspDot.svelte",
  "components/PdfPanel.svelte",
  "components/Select.svelte",
  "components/Toasts.svelte",
  "components/ToolProgress.svelte",
  "components/Tooltip.svelte",
];

const forbidden = /(^|[\s;{])(transform|opacity)\s*:/;

function keyframes(source: string): { name: string; body: string; start: number; end: number }[] {
  const found: { name: string; body: string; start: number; end: number }[] = [];
  for (const m of source.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    found.push({ name: m[1], body: source.slice(start, i - 1), start: m.index, end: i });
  }
  return found;
}

/** Keyframes some `animation` or `animation-name` declaration refers to. */
function usedKeyframes(source: string) {
  const frames = keyframes(source);
  let rest = "";
  let at = 0;
  for (const f of frames) {
    rest += source.slice(at, f.start);
    at = f.end;
  }
  rest += source.slice(at);
  const values = [...rest.matchAll(/(?<![\w-])animation(?:-name)?\s*:\s*([^;}]*)/g)].map((m) => m[1]);
  return frames.filter((f) => values.some((v) => v.split(/[\s,]+/).includes(f.name)));
}

/** Values of every `transition` and `transition-property` declaration. */
const transitions = (source: string) =>
  [...source.matchAll(/(?<![\w-])transition(?:-property)?\s*:\s*([^;}]*)/g)].map((m) => m[1]);

// A rule's declarations, for every selector list that names exactly this selector.
function declarations(source: string, selector: string): string {
  const out: string[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").some((s) => s.trim() === selector)) out.push(m[2]);
  }
  return out.join("\n");
}

describe("no transform or opacity animation on glass (#151)", () => {
  test.each(onGlass)("%s: used keyframes leave transform and opacity alone", (file) => {
    for (const { name, body } of usedKeyframes(read(file))) {
      expect(body, `${file} @keyframes ${name}`).not.toMatch(forbidden);
    }
  });

  test.each(onGlass)("%s: no transition on transform, opacity or all", (file) => {
    for (const value of transitions(read(file))) {
      expect(value, file).not.toMatch(/(?<![\w-])(transform|opacity|all)(?![\w-])/);
    }
  });

  test("finds a used keyframe and a transition in the scanned syntax", () => {
    const sample = ".a { animation: spin 1s; transition: opacity 0.1s; } @keyframes spin { to { opacity: 0; } } @keyframes idle { to { opacity: 0; } }";
    expect(usedKeyframes(sample).map((f) => f.name)).toEqual(["spin"]);
    expect(transitions(sample)).toEqual(["opacity 0.1s"]);
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
    const rule = declarations(read("app.css"), ".gbtn::before");
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/transition[^;]*opacity/);
  });
});
