import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ["browser"] },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
    // Safety net for a loaded machine (many agents running checks at once); slow work belongs
    // in beforeAll, not in the first test.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
