import { t } from "./i18n/index.svelte";

export type Mode = "text" | "markdown" | "latex" | "code";

/** Kept apart from modes.ts so that code which only needs the names doesn't load the editor extensions. */
export const MODES: { id: Mode; label: string }[] = [
  { id: "text", get label() { return t("app.mode.text"); } },
  { id: "markdown", label: "Markdown" },
  { id: "latex", label: "LaTeX" },
  { id: "code", label: "Code" },
];
