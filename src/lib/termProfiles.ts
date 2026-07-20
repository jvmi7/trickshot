// Per-workspace TERMINAL profiles: each worktree's terminal keeps the APP
// THEME's background (uniform across workspaces) and gets an ANSI palette
// DERIVED from its GLYPH PALETTE (identityGlyph.ts › paletteFor) — the same
// family that colors the sidebar mark. The identity signal — the ACCENT that
// IS the terminal's main text color + cursor AND the glyph left of the
// workspace name (plus the header ❯ and fleet icons) — is that palette's
// lightest color, so terminal ↔ sidebar mapping is exact. Assignment is
// stable (path hash → palette). Plain TS on purpose: the palettes are data,
// not app styling, so the design-system literal scan doesn't apply. Pure +
// tested.

import { GLYPH_PALETTES, type GlyphPalette, paletteFor } from "./identityGlyph";

export interface TermProfile {
  id: string;
  label: string;
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

// Neutral anchors shared by every derived scheme — only the colored slots
// carry the palette's identity.
const ANSI_BLACK = "#262626";
const ANSI_WHITE = "#d9d9d9";
const ANSI_BRIGHT_BLACK = "#595959";
const ANSI_BRIGHT_WHITE = "#ffffff";

/** Build a full ANSI-16 from a glyph palette: the palette's 7-step ramp fills
 *  the colored slots — normals take the darker end (colors 0–5), brights the
 *  lighter end (colors 1–6) — with neutral blacks/whites as anchors. */
function ansiFromPalette(p: GlyphPalette): TermProfile["ansi"] {
  const c = (i: number) => p.colors[i] ?? ANSI_WHITE;
  return [
    ANSI_BLACK,
    c(0), // red
    c(1), // green
    c(2), // yellow
    c(3), // blue
    c(4), // magenta
    c(5), // cyan
    ANSI_WHITE,
    ANSI_BRIGHT_BLACK,
    c(1), // bright red
    c(2), // bright green
    c(3), // bright yellow
    c(4), // bright blue
    c(5), // bright magenta
    c(6), // bright cyan
    ANSI_BRIGHT_WHITE,
  ];
}

/** One terminal profile per glyph palette, same order as GLYPH_PALETTES. */
export const TERM_PROFILES: TermProfile[] = GLYPH_PALETTES.map((p) => ({
  id: p.name,
  label: p.name.charAt(0).toUpperCase() + p.name.slice(1),
  ansi: ansiFromPalette(p),
}));

/** The workspace's terminal profile — the one derived from its glyph
 *  palette, so the mark and the terminal always share a family. */
export function profileFor(path: string): TermProfile {
  const palette = paletteFor(path);
  const p = TERM_PROFILES.find((t) => t.id === palette.name);
  // TERM_PROFILES mirrors GLYPH_PALETTES one-to-one; the ?? only satisfies
  // the possibly-undefined find result.
  return p ?? (TERM_PROFILES[0] as TermProfile);
}

/** Relative luminance of a #rrggbb hex (sRGB weights) — enough to rank
 *  palette colors by lightness. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff);
}

/** THE identity color: the terminal's MAIN TEXT + cursor, the sidebar glyph,
 *  the header ❯, and the fleet icon — one exact color, everywhere. It is the
 *  LIGHTEST color of the workspace's glyph palette (best contrast on the dark
 *  canvas), so the mark and the terminal text always read as one family. */
export function profileAccent(path: string): string {
  const colors = paletteFor(path).colors;
  let best = colors[0] ?? "currentColor";
  for (const c of colors) if (luminance(c) > luminance(best)) best = c;
  return best;
}
