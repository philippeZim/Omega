import { describe, expect, test } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";

type Fs = { readFileSync(path: string, enc: "utf8"): string };
const proc = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = proc.getBuiltinModule("node:fs") as Fs;

// In dev builds Svelte wraps an assignment whose value is used in `$.assign*`, which logs
// assignment_value_stale at runtime when the value is a state proxy.
function devOutput(file: string): string {
  const source = fs.readFileSync(`${proc.cwd()}/src/lib/${file}`, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  return compileModule(js, { dev: true, filename: file, generate: "client" }).js.code;
}

describe("no assignment_value_stale (#153)", () => {
  test.each([
    ["ui.svelte.ts", "toasts"],
    ["layout.svelte.ts", "open"],
    ["latex/controller.svelte.ts", "outline"],
  ])("%s does not use the value of an assignment to state (%s)", (file) => {
    expect(devOutput(file)).not.toMatch(/\$\.assign/);
  });
});
