// Per-workspace TERMINAL profiles: each worktree's terminal gets a complete
// color scheme of its own — full 16-color ANSI palette, background (+ opacity,
// blended toward the app theme's bg so profiles sit IN the app rather than
// clash with it), foreground, cursor, and an identity accent used by the
// header ❯ / sidebar chips / fleet icons. Assignment is stable (path hash →
// profile), so a workspace keeps its look across restarts. The app chrome
// keeps the global theme — profiles are terminal-only. Plain TS on purpose:
// the palettes are data (classic public schemes), not app styling, so the
// design-system literal scan doesn't apply. Pure + tested.

import { workspaceHue } from "./utils";

export interface TermProfile {
  id: string;
  label: string;
  /** Terminal background, blended over the app theme bg by `bgOpacity`. */
  bg: string;
  /** 0–1: how much of `bg` survives the blend (1 = the profile's own bg). */
  bgOpacity: number;
  fg: string;
  cursor: string;
  /** Identity accent (header ❯, sidebar chip, fleet icon) — chosen distinct
   *  across profiles, not always the cursor color. */
  accent: string;
  /** ANSI 0–15 in slot order (black…white, brightBlack…brightWhite). */
  ansi: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
}

export const TERM_PROFILES: TermProfile[] = [
  {
    id: "dracula",
    label: "Dracula",
    bg: "#282a36",
    bgOpacity: 0.95,
    fg: "#f8f8f2",
    cursor: "#ff79c6",
    accent: "#ff79c6",
    ansi: [
      "#21222c",
      "#ff5555",
      "#50fa7b",
      "#f1fa8c",
      "#bd93f9",
      "#ff79c6",
      "#8be9fd",
      "#f8f8f2",
      "#6272a4",
      "#ff6e6e",
      "#69ff94",
      "#ffffa5",
      "#d6acff",
      "#ff92df",
      "#a4ffff",
      "#ffffff",
    ],
  },
  {
    id: "nord",
    label: "Nord",
    bg: "#2e3440",
    bgOpacity: 0.95,
    fg: "#d8dee9",
    cursor: "#88c0d0",
    accent: "#88c0d0",
    ansi: [
      "#3b4252",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#88c0d0",
      "#e5e9f0",
      "#4c566a",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#8fbcbb",
      "#eceff4",
    ],
  },
  {
    id: "gruvbox",
    label: "Gruvbox Dark",
    bg: "#282828",
    bgOpacity: 0.95,
    fg: "#ebdbb2",
    cursor: "#fe8019",
    accent: "#fe8019",
    ansi: [
      "#282828",
      "#cc241d",
      "#98971a",
      "#d79921",
      "#458588",
      "#b16286",
      "#689d6a",
      "#a89984",
      "#928374",
      "#fb4934",
      "#b8bb26",
      "#fabd2f",
      "#83a598",
      "#d3869b",
      "#8ec07c",
      "#ebdbb2",
    ],
  },
  {
    id: "solarized",
    label: "Solarized Dark",
    bg: "#002b36",
    bgOpacity: 0.92,
    fg: "#839496",
    cursor: "#93a1a1",
    accent: "#b58900",
    ansi: [
      "#073642",
      "#dc322f",
      "#859900",
      "#b58900",
      "#268bd2",
      "#d33682",
      "#2aa198",
      "#eee8d5",
      "#586e75",
      "#cb4b16",
      "#586e75",
      "#657b83",
      "#839496",
      "#6c71c4",
      "#93a1a1",
      "#fdf6e3",
    ],
  },
  {
    id: "tokyo",
    label: "Tokyo Night",
    bg: "#1a1b26",
    bgOpacity: 1,
    fg: "#c0caf5",
    cursor: "#7aa2f7",
    accent: "#7aa2f7",
    ansi: [
      "#15161e",
      "#f7768e",
      "#9ece6a",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#a9b1d6",
      "#414868",
      "#f7768e",
      "#9ece6a",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#c0caf5",
    ],
  },
  {
    id: "catppuccin",
    label: "Catppuccin Mocha",
    bg: "#1e1e2e",
    bgOpacity: 1,
    fg: "#cdd6f4",
    cursor: "#f5e0dc",
    accent: "#94e2d5",
    ansi: [
      "#45475a",
      "#f38ba8",
      "#a6e3a1",
      "#f9e2af",
      "#89b4fa",
      "#f5c2e7",
      "#94e2d5",
      "#bac2de",
      "#585b70",
      "#f38ba8",
      "#a6e3a1",
      "#f9e2af",
      "#89b4fa",
      "#f5c2e7",
      "#94e2d5",
      "#a6adc8",
    ],
  },
  {
    id: "onedark",
    label: "One Dark",
    bg: "#282c34",
    bgOpacity: 0.95,
    fg: "#abb2bf",
    cursor: "#61afef",
    accent: "#c678dd",
    ansi: [
      "#282c34",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#abb2bf",
      "#5c6370",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#ffffff",
    ],
  },
  {
    id: "monokai",
    label: "Monokai",
    bg: "#272822",
    bgOpacity: 0.95,
    fg: "#f8f8f2",
    cursor: "#a6e22e",
    accent: "#a6e22e",
    ansi: [
      "#272822",
      "#f92672",
      "#a6e22e",
      "#f4bf75",
      "#66d9ef",
      "#ae81ff",
      "#a1efe4",
      "#f8f8f2",
      "#75715e",
      "#f92672",
      "#a6e22e",
      "#f4bf75",
      "#66d9ef",
      "#ae81ff",
      "#a1efe4",
      "#f9f8f5",
    ],
  },
];

/** The workspace's terminal profile — stable path-hash assignment. */
export function profileFor(path: string): TermProfile {
  const p = TERM_PROFILES[workspaceHue(path) % TERM_PROFILES.length];
  // TERM_PROFILES is non-empty and the index is modulo its length; the ?? only
  // satisfies noUncheckedIndexedAccess.
  return p ?? (TERM_PROFILES[0] as TermProfile);
}

/** Identity accent for chips / the header ❯ / fleet icons. */
export function profileAccent(path: string): string {
  return profileFor(path).accent;
}

/** The profile bg blended over the app theme bg by its opacity — a CSS color
 *  expression (var() stays live per app theme; resolved by the browser). */
export function profileBg(path: string): string {
  const p = profileFor(path);
  return `color-mix(in srgb, ${p.bg} ${Math.round(p.bgOpacity * 100)}%, var(--base-bg))`;
}
