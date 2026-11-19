/**
 * Syntax colour presets. Only token colours change; the editor keeps the app's dark glass
 * background. Each preset also brings a matching 16-colour terminal palette.
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
  group: "Klassiker" | "Modern" | "Warm & Retro";
  colors: SyntaxColors;
  /** black red green yellow blue magenta cyan white, then the bright variants */
  ansi: string[];
}

export const SYNTAX_THEMES: SyntaxTheme[] = [
  {
    id: "xcode", name: "Xcode Dark", group: "Klassiker",
    colors: { plain: "#ffffff", keyword: "#fc5fa3", string: "#fc6a5d", number: "#d0bf69", comment: "#6c7986", type: "#5dd8ff", function: "#67b7a4", definition: "#41a1c0", property: "#a167e6", preproc: "#fd8f3f", operator: "rgba(235,235,245,0.75)", invalid: "#ff453a" },
    ansi: ["#1f1f24", "#fc6a5d", "#67b7a4", "#d0bf69", "#5dd8ff", "#fc5fa3", "#41a1c0", "#dfdfe0", "#6c7986", "#ff8170", "#84d6ab", "#e5d27a", "#6bdfff", "#ff7ab2", "#5ac8de", "#ffffff"],
  },
  {
    id: "onedark", name: "One Dark", group: "Klassiker",
    colors: { plain: "#abb2bf", keyword: "#c678dd", string: "#98c379", number: "#d19a66", comment: "#5c6370", type: "#e5c07b", function: "#61afef", definition: "#e06c75", property: "#e06c75", preproc: "#c678dd", operator: "#56b6c2", invalid: "#f44747" },
    ansi: ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"],
  },
  {
    id: "monokai", name: "Monokai", group: "Klassiker",
    colors: { plain: "#f8f8f2", keyword: "#f92672", string: "#e6db74", number: "#ae81ff", comment: "#75715e", type: "#66d9ef", function: "#a6e22e", definition: "#a6e22e", property: "#fd971f", preproc: "#f92672", operator: "#f92672", invalid: "#f44747" },
    ansi: ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"],
  },
  {
    id: "dracula", name: "Dracula", group: "Klassiker",
    colors: { plain: "#f8f8f2", keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", comment: "#6272a4", type: "#8be9fd", function: "#50fa7b", definition: "#f8f8f2", property: "#ffb86c", preproc: "#ff79c6", operator: "#ff79c6", invalid: "#ff5555" },
    ansi: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
  },
  {
    id: "solarized", name: "Solarized Dark", group: "Klassiker",
    colors: { plain: "#93a1a1", keyword: "#859900", string: "#2aa198", number: "#d33682", comment: "#586e75", type: "#b58900", function: "#268bd2", definition: "#268bd2", property: "#6c71c4", preproc: "#cb4b16", operator: "#93a1a1", invalid: "#dc322f" },
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#93a1a1", "#839496", "#657b83", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  {
    id: "github", name: "GitHub Dark", group: "Modern",
    colors: { plain: "#e6edf3", keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", comment: "#8b949e", type: "#ffa657", function: "#d2a8ff", definition: "#ffa657", property: "#79c0ff", preproc: "#ff7b72", operator: "#ff7b72", invalid: "#f85149" },
    ansi: ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"],
  },
  {
    id: "tokyonight", name: "Tokyo Night", group: "Modern",
    colors: { plain: "#c0caf5", keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", comment: "#565f89", type: "#2ac3de", function: "#7aa2f7", definition: "#c0caf5", property: "#73daca", preproc: "#7dcfff", operator: "#89ddff", invalid: "#f7768e" },
    ansi: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"],
  },
  {
    id: "catppuccin", name: "Catppuccin Mocha", group: "Modern",
    colors: { plain: "#cdd6f4", keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387", comment: "#6c7086", type: "#f9e2af", function: "#89b4fa", definition: "#cdd6f4", property: "#b4befe", preproc: "#f5c2e7", operator: "#89dceb", invalid: "#f38ba8" },
    ansi: ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"],
  },
  {
    id: "nord", name: "Nord", group: "Modern",
    colors: { plain: "#d8dee9", keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", comment: "#616e88", type: "#8fbcbb", function: "#88c0d0", definition: "#d8dee9", property: "#8fbcbb", preproc: "#5e81ac", operator: "#81a1c1", invalid: "#bf616a" },
    ansi: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"],
  },
  {
    id: "nightowl", name: "Night Owl", group: "Modern",
    colors: { plain: "#d6deeb", keyword: "#c792ea", string: "#ecc48d", number: "#f78c6c", comment: "#637777", type: "#ffcb8b", function: "#82aaff", definition: "#addb67", property: "#7fdbca", preproc: "#c792ea", operator: "#7fdbca", invalid: "#ef5350" },
    ansi: ["#011627", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff", "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff"],
  },
  {
    id: "gruvbox", name: "Gruvbox Dark", group: "Warm & Retro",
    colors: { plain: "#ebdbb2", keyword: "#fb4934", string: "#b8bb26", number: "#d3869b", comment: "#928374", type: "#fabd2f", function: "#8ec07c", definition: "#83a598", property: "#83a598", preproc: "#fe8019", operator: "#fe8019", invalid: "#fb4934" },
    ansi: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
  },
  {
    id: "ayu", name: "Ayu Mirage", group: "Warm & Retro",
    colors: { plain: "#cccac2", keyword: "#ffa759", string: "#d5ff80", number: "#dfbfff", comment: "#6c7a8b", type: "#73d0ff", function: "#ffd173", definition: "#cccac2", property: "#5ccfe6", preproc: "#f29e74", operator: "#f29e74", invalid: "#ff6666" },
    ansi: ["#171b24", "#ed8274", "#87d96c", "#facc6e", "#6dcbfa", "#dabafa", "#90e1c6", "#c7c7c7", "#686868", "#f28779", "#d5ff80", "#ffd173", "#73d0ff", "#dfbfff", "#95e6cb", "#ffffff"],
  },
  {
    id: "rosepine", name: "Rosé Pine", group: "Warm & Retro",
    colors: { plain: "#e0def4", keyword: "#31748f", string: "#f6c177", number: "#ebbcba", comment: "#6e6a86", type: "#9ccfd8", function: "#ebbcba", definition: "#e0def4", property: "#c4a7e7", preproc: "#eb6f92", operator: "#908caa", invalid: "#eb6f92" },
    ansi: ["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"],
  },
];

export const themeById = (id: string) => SYNTAX_THEMES.find((t) => t.id === id) ?? SYNTAX_THEMES[0];

/** CSS custom properties for a theme (used globally and for preview cards). */
export function themeVars(t: SyntaxTheme): string {
  return Object.entries(t.colors)
    .map(([k, v]) => `--syn-${k}: ${v};`)
    .join(" ");
}
