#!/usr/bin/env node
// dev/audit-gate.mjs <cargo-audit.json> <pnpm-audit.json> — fails only on a High or Critical advisory that
// isn't ignored with a reason (Rust: src-tauri/deny.toml, npm: pnpm.auditConfig.ignoreGhsas in package.json).
// A Rust advisory without a CVSS 3 score counts as High, so an unknown severity can't slip through.
// A missing or broken report only warns, so an outage of an advisory service can't block merges.
import { readFileSync } from "node:fs";

const [cargoPath, pnpmPath] = process.argv.slice(2);
if (!cargoPath || !pnpmPath) {
  console.error("usage: audit-gate.mjs <cargo-audit.json> <pnpm-audit.json>");
  process.exit(2);
}

function report(path, tool) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.log(`::warning::${tool} produced no readable report: ${e.message}`);
    return null;
  }
}

/** CVSS 3.x base score of a vector, or null if it isn't a complete CVSS 3 vector. */
function cvss3Score(vector) {
  if (!/^CVSS:3\.[01]\//.test(vector ?? "")) return null;
  const m = Object.fromEntries(vector.split("/").slice(1).map((p) => p.split(":")));
  const changed = m.S === "C";
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV];
  const ac = { L: 0.77, H: 0.44 }[m.AC];
  const pr = (changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 })[m.PR];
  const ui = { N: 0.85, R: 0.62 }[m.UI];
  const cia = { H: 0.56, L: 0.22, N: 0 };
  const [c, i, a] = [cia[m.C], cia[m.I], cia[m.A]];
  if ([av, ac, pr, ui, c, i, a].some((x) => x === undefined) || !["U", "C"].includes(m.S)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const base = changed ? 1.08 * (impact + exploitability) : impact + exploitability;
  const roundUp = (x) => {
    const n = Math.round(x * 100000);
    return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10;
  };
  return roundUp(Math.min(base, 10));
}

const denyToml = readFileSync(new URL("../src-tauri/deny.toml", import.meta.url), "utf8");
const ignored = new Set([...denyToml.matchAll(/\{\s*id\s*=\s*"([^"]+)"\s*,\s*reason\s*=\s*"[^"]+"/g)].map((x) => x[1]));

const blocking = [];
const notes = [];

for (const v of report(cargoPath, "cargo audit")?.vulnerabilities?.list ?? []) {
  const { id, title, cvss } = v.advisory;
  const label = `${id} ${v.package.name} ${v.package.version}: ${title}`;
  if (ignored.has(id)) {
    notes.push(`ignored ${label}`);
    continue;
  }
  const score = cvss3Score(cvss);
  if (score === null || score >= 7) blocking.push(`${label} (CVSS ${score ?? "unknown"})`);
  else notes.push(`below High ${label} (CVSS ${score})`);
}

for (const a of Object.values(report(pnpmPath, "pnpm audit")?.advisories ?? {})) {
  const label = `${a.github_advisory_id ?? a.id} ${a.module_name}: ${a.title}`;
  if (a.severity === "high" || a.severity === "critical") blocking.push(`${label} (${a.severity})`);
  else notes.push(`below High ${label} (${a.severity})`);
}

for (const n of notes) console.log(`::notice::${n}`);
if (blocking.length) {
  for (const b of blocking) console.log(`::error::New High/Critical advisory: ${b}`);
  process.exit(1);
}
console.log(`No new High or Critical advisories (${notes.length} other finding(s)).`);
