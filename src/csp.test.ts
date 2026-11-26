// @ts-ignore -- the project has no @types/node; this test only runs under Node.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { cspString, devCsp, type CspMap } from "../dev/csp";

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8") as string);
const security = conf.app.security;
const csp = security.csp as CspMap;
const sources = (directive: string) => {
  const s = csp[directive];
  return Array.isArray(s) ? s : s ? s.split(/\s+/) : [];
};

/**
 * The Content Security Policy (#166). Every source here is needed by something in the app; a new
 * one is a decision, so this test has to change with it.
 */
describe("Content Security Policy", () => {
  test("is exactly the reviewed policy", () => {
    expect(csp).toEqual({
      "default-src": ["'self'"],
      // Tauri adds a hash of every bundled script; nothing inline, nothing remote.
      "script-src": ["'self'"],
      // Svelte templates, KaTeX and pdf.js set style attributes; CodeMirror and xterm add <style>.
      "style-src": ["'self'", "'unsafe-inline'"],
      // Local files (asset protocol), data:/blob: images, allowed remote images in Markdown.
      "img-src": ["'self'", "asset:", "http://asset.localhost", "data:", "blob:", "http:", "https:"],
      // Small fonts are inlined into the CSS as data: URLs.
      "font-src": ["'self'", "data:"],
      // IPC, PDFs and images over the asset protocol, package lists (npm, PyPI, Node), and the
      // control MCP screenshot fetching what an <img> shows.
      "connect-src": ["'self'", "ipc:", "http://ipc.localhost", "asset:", "http://asset.localhost", "data:", "blob:", "http:", "https:"],
      // The pdf.js worker is a bundled file.
      "worker-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
    });
  });

  test("no script can come from anywhere but the app's own files", () => {
    for (const d of ["default-src", "script-src", "worker-src"]) {
      expect(sources(d), d).toEqual(["'self'"]);
    }
    for (const d of ["object-src", "base-uri", "form-action"]) expect(sources(d), d).toEqual(["'none'"]);
  });

  test("never allows eval, inline scripts, inline event handlers or wildcards", () => {
    for (const [d, s] of Object.entries(csp)) {
      const list = Array.isArray(s) ? s : s.split(/\s+/);
      expect(list, d).not.toContain("'unsafe-eval'");
      expect(list, d).not.toContain("'unsafe-hashes'");
      expect(list, d).not.toContain("*");
      if (d !== "style-src") expect(list, d).not.toContain("'unsafe-inline'");
    }
    expect(csp["script-src-elem"]).toBeUndefined();
    expect(csp["script-src-attr"]).toBeUndefined();
  });

  test("Tauri may still hash scripts; it only leaves style-src alone", () => {
    // A nonce or hash in style-src would make the browser ignore 'unsafe-inline'.
    expect(security.dangerousDisableAssetCspModification).toEqual(["style-src"]);
  });

  test("index.html has nothing inline the policy would block", () => {
    const html = readFileSync("index.html", "utf8") as string;
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body.trim()).toBe("");
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    // One policy only: a second one in a <meta> would apply on top of Tauri's header.
    expect(html).not.toMatch(/Content-Security-Policy/i);
  });
});

describe("policy in development", () => {
  test("Vite sends the release policy", () => {
    const vite = readFileSync("vite.config.ts", "utf8") as string;
    expect(vite).toMatch(/"Content-Security-Policy":\s*devCsp\(tauriConf\.app\.security\.csp/);
  });

  test("adds only the HMR socket and Vite's reconnect worker", () => {
    const dev = devCsp(csp);
    const release = cspString(csp);
    expect(dev).toBe(
      release
        .replace(/(connect-src [^;]*)/, "$1 ws://localhost:*")
        .replace(/(worker-src [^;]*)/, "$1 blob:"),
    );
    expect(devCsp(csp, "192.168.1.5")).toContain("ws://192.168.1.5:*");
  });

  test("cspString joins directives and sources", () => {
    expect(cspString({ "default-src": ["'self'"], "img-src": "'self' data:" })).toBe("default-src 'self'; img-src 'self' data:");
  });
});
