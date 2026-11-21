/** User settings (persisted): appearance (dark/light), syntax colour theme per appearance, text sizes. */
import { themeById, themeVars } from "./syntaxThemes";
import { setTerminalPalette, setTerminalFontSize } from "./terminal.svelte";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as ed from "./editor";
import { onGlobalChange } from "./windowStorage";

const num = (k: string, d: number) => Number(localStorage.getItem(k)) || d;

/** Slider maximum of the prose width – means "no limit". */
export const PROSE_WIDTH_FULL = 1800;

export type Appearance = "dark" | "light";
/** Panel material: the regular frosted glass, or the clearer, refractive "Liquid Glass". */
export type Material = "solid" | "liquid";

export const settings = $state({
  appearance: (localStorage.getItem("appearance") === "light" ? "light" : "dark") as Appearance,
  material: (localStorage.getItem("material") === "liquid" ? "liquid" : "solid") as Material,
  /** Chosen syntax theme per appearance; `syntaxTheme` is the one currently applied. */
  syntaxThemeDark: localStorage.getItem("syntaxThemeDark") || localStorage.getItem("syntaxTheme") || "xcode",
  syntaxThemeLight: localStorage.getItem("syntaxThemeLight") || "xcode-light",
  syntaxTheme: "",
  codeFontSize: num("codeFontSize", 14),
  proseFontSize: num("proseFontSize", 16),
  /** Max. column width in Text/Markdown mode; PROSE_WIDTH_FULL = whole editor width. */
  proseWidth: num("proseWidth", 1000),
  terminalFontSize: num("terminalFontSize", 13),
  uiScale: num("uiScale", 1),
  open: false,
});

/** Editor/terminal text sizes (CSS variables + xterm option) and the overall UI zoom. */
export function applySizes() {
  const root = document.documentElement.style;
  root.setProperty("--code-font-size", `${settings.codeFontSize}px`);
  root.setProperty("--prose-font-size", `${settings.proseFontSize}px`);
  root.setProperty("--prose-width", settings.proseWidth >= PROSE_WIDTH_FULL ? "none" : `${settings.proseWidth}px`);
  setTerminalFontSize(settings.terminalFontSize);
  getCurrentWebview().setZoom(settings.uiScale).catch(() => {
    // Fallback if the zoom permission is unavailable.
    document.body.style.zoom = String(settings.uiScale);
  });
  for (const k of ["codeFontSize", "proseFontSize", "proseWidth", "terminalFontSize", "uiScale"] as const) localStorage.setItem(k, String(settings[k]));
  // CodeMirror caches line heights/char widths; a CSS-variable font change needs a re-measure,
  // otherwise the cursor keeps its old size until the next click or resize.
  requestAnimationFrame(() => {
    const v = ed.getView();
    if (v) {
      v.requestMeasure();
      v.dispatch({ selection: v.state.selection });
    }
  });
}

export function setSize(key: "codeFontSize" | "proseFontSize" | "proseWidth" | "terminalFontSize" | "uiScale", value: number) {
  settings[key] = value;
  applySizes();
}

let styleEl: HTMLStyleElement | null = null;

/** Applies a syntax theme and remembers it for the appearance it belongs to. */
export function applySyntaxTheme(id: string) {
  const t = themeById(id);
  settings.syntaxTheme = t.id;
  if (t.light) settings.syntaxThemeLight = t.id;
  else settings.syntaxThemeDark = t.id;
  localStorage.setItem(t.light ? "syntaxThemeLight" : "syntaxThemeDark", t.id);
  styleEl ??= document.head.appendChild(document.createElement("style"));
  styleEl.textContent = `:root { ${themeVars(t)} }`;
  setTerminalPalette(t.ansi, settings.appearance);
}

/** Switches the whole UI between dark and light, together with that appearance's syntax theme. */
export function setAppearance(a: Appearance) {
  settings.appearance = a;
  localStorage.setItem("appearance", a);
  document.documentElement.dataset.theme = a;
  applySyntaxTheme(a === "light" ? settings.syntaxThemeLight : settings.syntaxThemeDark);
}

/** Switches the panel material (independent of light/dark). */
export function setMaterial(m: Material) {
  settings.material = m;
  localStorage.setItem("material", m);
  document.documentElement.dataset.material = m;
}

setAppearance(settings.appearance);
setMaterial(settings.material);
applySizes();

// Changed in another window.
onGlobalChange("appearance", (v) => setAppearance(v === "light" ? "light" : "dark"));
onGlobalChange("material", (v) => setMaterial(v === "liquid" ? "liquid" : "solid"));
onGlobalChange(["syntaxThemeDark", "syntaxThemeLight"], () => {
  settings.syntaxThemeDark = localStorage.getItem("syntaxThemeDark") || settings.syntaxThemeDark;
  settings.syntaxThemeLight = localStorage.getItem("syntaxThemeLight") || settings.syntaxThemeLight;
  applySyntaxTheme(settings.appearance === "light" ? settings.syntaxThemeLight : settings.syntaxThemeDark);
});
for (const k of ["codeFontSize", "proseFontSize", "proseWidth", "terminalFontSize", "uiScale"] as const) {
  onGlobalChange(k, (v) => {
    const n = Number(v);
    if (n > 0 && n !== settings[k]) {
      settings[k] = n;
      applySizes();
    }
  });
}
