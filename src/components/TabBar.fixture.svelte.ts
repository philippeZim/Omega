// Reactive stand-in for the app state in TabBar.test.ts.
export const app = $state<{ tabs: { id: string; path: string | null; name: string; dirty: boolean }[]; activeId: string | null; mode: string }>({
  tabs: [],
  activeId: null,
  mode: "text",
});
