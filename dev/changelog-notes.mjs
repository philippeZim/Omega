#!/usr/bin/env node
// dev/changelog-notes.mjs <version> [--plain] — prints that version's CHANGELOG.md entry without its heading.
// --plain removes Markdown syntax, because the in-app update dialog shows the notes as plain text.
// --release fails unless the heading has a release date, so an "Unreleased" entry can't ship from a tag.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const plain = args.includes("--plain");
const release = args.includes("--release");
const version = args.find((a) => !a.startsWith("--"));
if (!version) {
  console.error("usage: changelog-notes.mjs <version> [--plain] [--release]");
  process.exit(2);
}

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l === `## [${version}]` || l.startsWith(`## [${version}] `));
if (start < 0) {
  console.error(`CHANGELOG.md has no entry for ${version}`);
  process.exit(1);
}
if (release && !/ - \d{4}-\d{2}-\d{2}$/.test(lines[start])) {
  console.error(`The CHANGELOG.md heading for ${version} needs a release date: "${lines[start]}"`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex((l) => l.startsWith("## ") || /^\[[^\]]+\]: /.test(l));
let notes = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
if (!notes) {
  console.error(`The CHANGELOG.md entry for ${version} is empty`);
  process.exit(1);
}

if (plain) {
  notes = notes
    .replace(/^#{3,} +/gm, "")
    .replace(/^- /gm, "• ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "");
}
process.stdout.write(notes + "\n");
