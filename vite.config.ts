import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import tauriConf from "./src-tauri/tauri.conf.json";
import { devCsp } from "./dev/csp";
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    // Instances started by dev/omega-mcp.mjs run their own Vite on a free port.
    port: Number(process.env.OMEGA_VITE_PORT) || 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    // The release policy applies in development too (see dev/csp.ts).
    headers: { "Content-Security-Policy": devCsp(tauriConf.app.security.csp, host || "localhost") },
  },
}));
