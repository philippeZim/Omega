// Reactive stand-in for the app state in TabBar.test.ts.
type T = { id: string; path: string | null; name: string; dirty: boolean };
export const app = $state<{ tabs: T[]; activeId: string | null; mode: string; groups: { groups: Record<string, { id: string; tabs: string[]; active: string | null; modes: Record<string, string> }>; focused: string } }>({
  tabs: [],
  activeId: null,
  mode: "text",
  groups: { groups: { main: { id: "main", tabs: [], active: null, modes: {} } }, focused: "main" },
});
