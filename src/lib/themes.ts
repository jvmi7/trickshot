// THE SINGLE SOURCE OF TRUTH FOR COLOR THEMES.
//
// A theme is just a complete semantic base palette. Everything else in the app —
// the shadcn `--*` tokens AND the bespoke `--app-*` tokens — derives from these
// `--base-*` vars via var(), so defining a palette here re-skins the whole UI.
// See THEMING.md for the full token→consumer map.
//
// To ADD a theme:    append one entry to `THEMES` with a full `palette`.
// To REMOVE a theme: delete its entry.
// To REORDER the picker: reorder `THEMES` (the first entry is the default).
// Nothing else to touch — the picker (stores.ts › THEMES) and the injected CSS
// (`installThemes`, called from main.ts) both derive from this list, and
// `<html data-theme="<id>">` selects the active one.

/** Every value a theme must define (the semantic base palette). Each key maps to
 *  a `--base-*` CSS var (see PALETTE_VARS). Keep this exhaustive: a theme defines
 *  ALL of them so it's fully self-contained (no implicit inheritance). */
export interface ThemePalette {
  /** app canvas */
  bg: string;
  /** panels: header, sidebar, cards, popovers */
  surface: string;
  /** hover / secondary / muted / accent surfaces */
  surfaceRaised: string;
  /** dividers, inputs */
  border: string;
  /** primary text */
  text: string;
  /** dim / secondary text */
  textMuted: string;
  /** brand accent */
  accent: string;
  /** text / icon on accent fills */
  onAccent: string;
  /** errors / destructive */
  danger: string;
  /** online / running */
  success: string;
  /** chart / info */
  info: string;
  /** chart / warning */
  warning: string;
  /** chart / extra */
  special: string;
  /** modal scrim */
  overlay: string;
  /** text-selection highlight fill, rendered at 20% (selected text recolors to --base-accent) */
  selection: string;
  /** terminal glyph glow — a full `text-shadow` value ("none" disables). Use
   *  currentColor layers so each glyph glows in its own ANSI color. */
  termGlow: string;
}

export interface Theme {
  /** Stable id used by `<html data-theme>` and persisted to localStorage. */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  palette: ThemePalette;
}

/** Maps each palette key to the CSS custom property it sets. The ONLY place the
 *  `--base-*` names live; `themesToCss` walks this so a new palette key is wired
 *  by adding it here + to ThemePalette (and consuming it in app.css). */
export const PALETTE_VARS: Record<keyof ThemePalette, string> = {
  bg: "--base-bg",
  surface: "--base-surface",
  surfaceRaised: "--base-surface-raised",
  border: "--base-border",
  text: "--base-text",
  textMuted: "--base-text-muted",
  accent: "--base-accent",
  onAccent: "--base-on-accent",
  danger: "--base-danger",
  success: "--base-success",
  info: "--base-info",
  warning: "--base-warning",
  special: "--base-special",
  overlay: "--base-overlay",
  selection: "--base-selection",
  termGlow: "--base-term-glow",
};

/** All themes. The FIRST entry is the default (also mirrored as the static
 *  fallback in app.css `:root`, so it paints before this module runs). */
export const THEMES: Theme[] = [
  {
    id: "terracotta",
    label: "Terracotta",
    // Neutral ramp keyed to the #121011 canvas (near-neutral dark greys with a
    // whisper of warmth); the TEXT colors are a separate warm cream family.
    palette: {
      bg: "#121011",
      surface: "#1c1a1a",
      surfaceRaised: "#272424",
      border: "#363232",
      text: "#f4f0ea",
      textMuted: "#a29d95",
      accent: "#d97757",
      onAccent: "#121011",
      danger: "#e06c6c",
      success: "#5fb87a",
      info: "#6b9fd9",
      warning: "#d9b257",
      special: "#b57fd9",
      overlay: "rgb(0 0 0 / 0.5)",
      selection: "#837c7c",
      // Warm ember: a soft core plus a gentle halo.
      termGlow:
        "0 0 3px color-mix(in srgb, currentColor 30%, transparent), 0 0 8px color-mix(in srgb, currentColor 22%, transparent)",
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    palette: {
      bg: "#0e1a24",
      surface: "#14242f",
      surfaceRaised: "#1d3340",
      border: "#2b4655",
      text: "#dce7ee",
      textMuted: "#7e98a8",
      accent: "#46b6d6",
      onAccent: "#07141c",
      danger: "#e0726c",
      success: "#4fc095",
      info: "#6bb6d9",
      warning: "#d9b257",
      special: "#9b8cf0",
      overlay: "rgb(0 0 0 / 0.5)",
      selection: "#837c7c",
      // Cool CRT: a tight core plus a soft halo (crisper than terracotta's).
      termGlow:
        "0 0 2px color-mix(in srgb, currentColor 28%, transparent), 0 0 9px color-mix(in srgb, currentColor 20%, transparent)",
    },
  },
  {
    id: "forest",
    label: "Forest",
    palette: {
      bg: "#121912",
      surface: "#1a231b",
      surfaceRaised: "#233026",
      border: "#354a38",
      text: "#e3eae2",
      textMuted: "#8aa08c",
      accent: "#7bbf6a",
      onAccent: "#0f160f",
      danger: "#e0726c",
      success: "#6cc77f",
      info: "#6b9fd9",
      warning: "#d9b257",
      special: "#b57fd9",
      overlay: "rgb(0 0 0 / 0.5)",
      selection: "#837c7c",
      // Phosphor: the strongest glow of the set — green-terminal nostalgia.
      termGlow:
        "0 0 3px color-mix(in srgb, currentColor 35%, transparent), 0 0 10px color-mix(in srgb, currentColor 26%, transparent)",
    },
  },
];

/** The default theme id (first in the list) — the picker/store fall back to it. */
export const DEFAULT_THEME = THEMES[0]?.id ?? "terracotta";

/** Generate one `:root[data-theme="<id>"]` block per theme. The `:root[...]`
 *  form (specificity 0,2,0) deliberately outranks the bare `:root` default in
 *  app.css (0,1,0), so the active theme always wins regardless of source order. */
export function themesToCss(): string {
  return THEMES.map((t) => {
    const decls = (Object.keys(PALETTE_VARS) as (keyof ThemePalette)[])
      .map((key) => `  ${PALETTE_VARS[key]}: ${t.palette[key]};`)
      .join("\n");
    return `:root[data-theme="${t.id}"] {\n${decls}\n}`;
  }).join("\n\n");
}

/** Inject the generated theme CSS once. Call BEFORE mount (see main.ts) so the
 *  active theme is in place before first paint. Idempotent. */
export function installThemes(): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById("theme-vars");
  if (!el) {
    el = document.createElement("style");
    el.id = "theme-vars";
    document.head.appendChild(el);
  }
  el.textContent = themesToCss();
}
