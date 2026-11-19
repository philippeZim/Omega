/** User settings (persisted). Currently: syntax colour theme (editor + terminal). */
import { themeById, themeVars } from "./syntaxThemes";
import { setTerminalPalette, setTerminalFontSize } from "./terminal.svelte";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as ed from "./editor";

const num = (k: string, d: number) => Number(localStorage.getItem(k)) || d;

export const settings = $state({
  syntaxTheme: localStorage.getItem("syntaxTheme") || "xcode",
  codeFontSize: num("codeFontSize", 14),
  proseFontSize: num("proseFontSize", 16),
  terminalFontSize: num("terminalFontSize", 13),
  uiScale: num("uiScale", 1),
  open: false,
});

/** Editor/terminal text sizes (CSS variables + xterm option) and the overall UI zoom. */
export function applySizes() {
  const root = document.documentElement.style;
  root.setProperty("--code-font-size", `${settings.codeFontSize}px`);
  root.setProperty("--prose-font-size", `${settings.proseFontSize}px`);
  setTerminalFontSize(settings.terminalFontSize);
  getCurrentWebview().setZoom(settings.uiScale).catch(() => {
    // Fallback if the zoom permission is unavailable.
    document.body.style.zoom = String(settings.uiScale);
  });
  for (const k of ["codeFontSize", "proseFontSize", "terminalFontSize", "uiScale"] as const) localStorage.setItem(k, String(settings[k]));
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

export function setSize(key: "codeFontSize" | "proseFontSize" | "terminalFontSize" | "uiScale", value: number) {
  settings[key] = value;
  applySizes();
}

let styleEl: HTMLStyleElement | null = null;

export function applySyntaxTheme(id: string) {
  const t = themeById(id);
  settings.syntaxTheme = t.id;
  localStorage.setItem("syntaxTheme", t.id);
  styleEl ??= document.head.appendChild(document.createElement("style"));
  styleEl.textContent = `:root { ${themeVars(t)} }`;
  setTerminalPalette(t.ansi);
}

applySyntaxTheme(settings.syntaxTheme);
applySizes();
