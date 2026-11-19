/**
 * Syntax colour presets. Only token colours change; the editor keeps the app's glass
 * background. Dark presets are offered in dark appearance, `light` presets in light appearance. Each preset also brings a matching 16-colour terminal palette.
 */
export interface SyntaxColors {
  plain: string;
  keyword: string;
  string: string;
  number: string;
  comment: string;
  type: string;
  function: string;
  definition: string;
  property: string;
  preproc: string;
  operator: string;
  invalid: string;
}

export interface SyntaxTheme {
  id: string;
  name: string;
  group: "classic" | "modern" | "retro";
  /** Light themes are tuned for the light appearance; the rest for dark. */
  light?: true;
  colors: SyntaxColors;
  /** black red green yellow blue magenta cyan white, then the bright variants */
  ansi: string[];
}

export const SYNTAX_THEMES: SyntaxTheme[] = [
  {
    id: "xcode", name: "Xcode Dark", group: "classic",
    colors: { plain: "#ffffff", keyword: "#fc5fa3", string: "#fc6a5d", number: "#d0bf69", comment: "#6c7986", type: "#5dd8ff", function: "#67b7a4", definition: "#41a1c0", property: "#a167e6", preproc: "#fd8f3f", operator: "rgba(235,235,245,0.75)", invalid: "#ff453a" },
    ansi: ["#1f1f24", "#fc6a5d", "#67b7a4", "#d0bf69", "#5dd8ff", "#fc5fa3", "#41a1c0", "#dfdfe0", "#6c7986", "#ff8170", "#84d6ab", "#e5d27a", "#6bdfff", "#ff7ab2", "#5ac8de", "#ffffff"],
  },
  {
    id: "onedark", name: "One Dark", group: "classic",
    colors: { plain: "#abb2bf", keyword: "#c678dd", string: "#98c379", number: "#d19a66", comment: "#5c6370", type: "#e5c07b", function: "#61afef", definition: "#e06c75", property: "#e06c75", preproc: "#c678dd", operator: "#56b6c2", invalid: "#f44747" },
    ansi: ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"],
  },
  {
    id: "monokai", name: "Monokai", group: "classic",
    colors: { plain: "#f8f8f2", keyword: "#f92672", string: "#e6db74", number: "#ae81ff", comment: "#75715e", type: "#66d9ef", function: "#a6e22e", definition: "#a6e22e", property: "#fd971f", preproc: "#f92672", operator: "#f92672", invalid: "#f44747" },
    ansi: ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"],
  },
  {
    id: "dracula", name: "Dracula", group: "classic",
    colors: { plain: "#f8f8f2", keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", comment: "#6272a4", type: "#8be9fd", function: "#50fa7b", definition: "#f8f8f2", property: "#ffb86c", preproc: "#ff79c6", operator: "#ff79c6", invalid: "#ff5555" },
    ansi: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
  },
  {
    id: "solarized", name: "Solarized Dark", group: "classic",
    colors: { plain: "#93a1a1", keyword: "#859900", string: "#2aa198", number: "#d33682", comment: "#586e75", type: "#b58900", function: "#268bd2", definition: "#268bd2", property: "#6c71c4", preproc: "#cb4b16", operator: "#93a1a1", invalid: "#dc322f" },
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#93a1a1", "#839496", "#657b83", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  {
    id: "github", name: "GitHub Dark", group: "modern",
    colors: { plain: "#e6edf3", keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", comment: "#8b949e", type: "#ffa657", function: "#d2a8ff", definition: "#ffa657", property: "#79c0ff", preproc: "#ff7b72", operator: "#ff7b72", invalid: "#f85149" },
    ansi: ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"],
  },
  {
    id: "tokyonight", name: "Tokyo Night", group: "modern",
    colors: { plain: "#c0caf5", keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", comment: "#565f89", type: "#2ac3de", function: "#7aa2f7", definition: "#c0caf5", property: "#73daca", preproc: "#7dcfff", operator: "#89ddff", invalid: "#f7768e" },
    ansi: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"],
  },
  {
    id: "catppuccin", name: "Catppuccin Mocha", group: "modern",
    colors: { plain: "#cdd6f4", keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387", comment: "#6c7086", type: "#f9e2af", function: "#89b4fa", definition: "#cdd6f4", property: "#b4befe", preproc: "#f5c2e7", operator: "#89dceb", invalid: "#f38ba8" },
    ansi: ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"],
  },
  {
    id: "nord", name: "Nord", group: "modern",
    colors: { plain: "#d8dee9", keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", comment: "#616e88", type: "#8fbcbb", function: "#88c0d0", definition: "#d8dee9", property: "#8fbcbb", preproc: "#5e81ac", operator: "#81a1c1", invalid: "#bf616a" },
    ansi: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"],
  },
  {
    id: "nightowl", name: "Night Owl", group: "modern",
    colors: { plain: "#d6deeb", keyword: "#c792ea", string: "#ecc48d", number: "#f78c6c", comment: "#637777", type: "#ffcb8b", function: "#82aaff", definition: "#addb67", property: "#7fdbca", preproc: "#c792ea", operator: "#7fdbca", invalid: "#ef5350" },
    ansi: ["#011627", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff", "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff"],
  },
  {
    id: "gruvbox", name: "Gruvbox Dark", group: "retro",
    colors: { plain: "#ebdbb2", keyword: "#fb4934", string: "#b8bb26", number: "#d3869b", comment: "#928374", type: "#fabd2f", function: "#8ec07c", definition: "#83a598", property: "#83a598", preproc: "#fe8019", operator: "#fe8019", invalid: "#fb4934" },
    ansi: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
  },
  {
    id: "ayu", name: "Ayu Mirage", group: "retro",
    colors: { plain: "#cccac2", keyword: "#ffa759", string: "#d5ff80", number: "#dfbfff", comment: "#6c7a8b", type: "#73d0ff", function: "#ffd173", definition: "#cccac2", property: "#5ccfe6", preproc: "#f29e74", operator: "#f29e74", invalid: "#ff6666" },
    ansi: ["#171b24", "#ed8274", "#87d96c", "#facc6e", "#6dcbfa", "#dabafa", "#90e1c6", "#c7c7c7", "#686868", "#f28779", "#d5ff80", "#ffd173", "#73d0ff", "#dfbfff", "#95e6cb", "#ffffff"],
  },
  {
    id: "rosepine", name: "Rosé Pine", group: "retro",
    colors: { plain: "#e0def4", keyword: "#31748f", string: "#f6c177", number: "#ebbcba", comment: "#6e6a86", type: "#9ccfd8", function: "#ebbcba", definition: "#e0def4", property: "#c4a7e7", preproc: "#eb6f92", operator: "#908caa", invalid: "#eb6f92" },
    ansi: ["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"],
  },
  {
    id: "xcode-light", name: "Xcode Light", group: "classic", light: true,
    colors: { plain: "#1d1d1f", keyword: "#9b2393", string: "#c41a16", number: "#1c00cf", comment: "#5d6c79", type: "#0b4f79", function: "#326d74", definition: "#0f68a0", property: "#6c36a9", preproc: "#643820", operator: "rgba(29,29,31,0.75)", invalid: "#d12f1b" },
    ansi: ["#1d1d1f", "#c41a16", "#1f7a35", "#8a6d00", "#0f68a0", "#9b2393", "#1f7a85", "#8e8e93", "#5d6c79", "#d12f1b", "#2a9c46", "#a88300", "#1c7fc1", "#ad3da4", "#2a8e9a", "#3c3c43"],
  },
  {
    id: "onelight", name: "One Light", group: "classic", light: true,
    colors: { plain: "#383a42", keyword: "#a626a4", string: "#50a14f", number: "#986801", comment: "#a0a1a7", type: "#c18401", function: "#4078f2", definition: "#e45649", property: "#e45649", preproc: "#a626a4", operator: "#0184bc", invalid: "#ca1243" },
    ansi: ["#383a42", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#a0a1a7", "#4f525e", "#ca1243", "#3e953a", "#986801", "#2f66e0", "#8f1f8d", "#0e7aa8", "#696c77"],
  },
  {
    id: "solarized-light", name: "Solarized Light", group: "classic", light: true,
    colors: { plain: "#586e75", keyword: "#859900", string: "#2aa198", number: "#d33682", comment: "#93a1a1", type: "#b58900", function: "#268bd2", definition: "#268bd2", property: "#6c71c4", preproc: "#cb4b16", operator: "#657b83", invalid: "#dc322f" },
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#93a1a1", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#2aa198", "#586e75"],
  },
  {
    id: "github-light", name: "GitHub Light", group: "modern", light: true,
    colors: { plain: "#1f2328", keyword: "#cf222e", string: "#0a3069", number: "#0550ae", comment: "#6e7781", type: "#953800", function: "#8250df", definition: "#953800", property: "#0550ae", preproc: "#cf222e", operator: "#cf222e", invalid: "#82071e" },
    ansi: ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"],
  },
  {
    id: "catppuccin-latte", name: "Catppuccin Latte", group: "modern", light: true,
    colors: { plain: "#4c4f69", keyword: "#8839ef", string: "#40a02b", number: "#fe640b", comment: "#9ca0b0", type: "#df8e1d", function: "#1e66f5", definition: "#e64553", property: "#7287fd", preproc: "#ea76cb", operator: "#04a5e5", invalid: "#d20f39" },
    ansi: ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"],
  },
  {
    id: "tokyonight-day", name: "Tokyo Night Day", group: "modern", light: true,
    colors: { plain: "#3760bf", keyword: "#9854f1", string: "#587539", number: "#b15c00", comment: "#848cb5", type: "#007197", function: "#2e7de9", definition: "#8c4351", property: "#007197", preproc: "#9854f1", operator: "#006a83", invalid: "#f52a65" },
    ansi: ["#343b58", "#f52a65", "#587539", "#8c6c3e", "#2e7de9", "#9854f1", "#007197", "#8990b3", "#6172b0", "#f52a65", "#587539", "#8c6c3e", "#2e7de9", "#9854f1", "#007197", "#a1a6c5"],
  },
  {
    id: "gruvbox-light", name: "Gruvbox Light", group: "retro", light: true,
    colors: { plain: "#3c3836", keyword: "#9d0006", string: "#79740e", number: "#8f3f71", comment: "#928374", type: "#b57614", function: "#427b58", definition: "#076678", property: "#076678", preproc: "#af3a03", operator: "#af3a03", invalid: "#9d0006" },
    ansi: ["#3c3836", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64", "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"],
  },
  {
    id: "rosepine-dawn", name: "Rosé Pine Dawn", group: "retro", light: true,
    colors: { plain: "#575279", keyword: "#286983", string: "#ea9d34", number: "#d7827e", comment: "#9893a5", type: "#56949f", function: "#d7827e", definition: "#907aa9", property: "#907aa9", preproc: "#286983", operator: "#797593", invalid: "#b4637a" },
    ansi: ["#575279", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#797593", "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279"],
  },
  {
    id: "ayu-light", name: "Ayu Light", group: "retro", light: true,
    colors: { plain: "#5c6166", keyword: "#fa8d3e", string: "#86b300", number: "#a37acc", comment: "#adaeb1", type: "#399ee6", function: "#f2ae49", definition: "#4cbf99", property: "#f07171", preproc: "#fa8d3e", operator: "#ed9366", invalid: "#e65050" },
    ansi: ["#5c6166", "#ea6c73", "#6cbf43", "#eba400", "#22a4e6", "#9e75c7", "#4cbf99", "#abb0b6", "#787b80", "#f07171", "#86b300", "#f2ae49", "#399ee6", "#a37acc", "#4cbf99", "#8a9199"],
  },
];

export const themeById = (id: string) => SYNTAX_THEMES.find((t) => t.id === id) ?? SYNTAX_THEMES[0];

/** CSS custom properties for a theme (used globally and for preview cards). */
export function themeVars(t: SyntaxTheme): string {
  return Object.entries(t.colors)
    .map(([k, v]) => `--syn-${k}: ${v};`)
    .join(" ");
}
