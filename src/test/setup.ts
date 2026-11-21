// Shared test setup: in-memory localStorage and a clean Tauri IPC mock per test.
import { afterEach, beforeEach } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

const store = new Map<string, string>();
const memoryStorage: Storage = {
  get length() { return store.size; },
  clear: () => store.clear(),
  getItem: (k) => (store.has(k) ? store.get(k)! : null),
  key: (i) => [...store.keys()][i] ?? null,
  removeItem: (k) => { store.delete(k); },
  setItem: (k, v) => { store.set(k, String(v)); },
};
Object.defineProperty(globalThis, "localStorage", { value: memoryStorage, configurable: true });

beforeEach(() => {
  // Default: every invoke resolves to null. Tests override with mockIPC(...) as needed.
  mockIPC(() => null, { shouldMockEvents: true });
});

afterEach(() => {
  clearMocks();
  store.clear();
});
