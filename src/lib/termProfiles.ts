// Per-workspace TERMINAL profiles: each worktree's terminal keeps the APP
// THEME's background (uniform across workspaces) and gets a MONOCHROMATIC
// ANSI palette — every one of the 16 slots is a shade or tint of the
// workspace's single identity ACCENT (the color of the 3×3 sidebar glyph,
// the header ❯, the fleet icon, and the terminal's main text + cursor: the
// glyph palette's lightest color, identityGlyph.ts › paletteFor). ANSI color
// semantics (red = error, green = ok) are deliberately traded for lightness
// steps — the whole TUI reads as one hue, so terminal ↔ sidebar mapping is
// total, not just the accent. Assignment is stable (path hash → palette).
// Plain TS on purpose: the palettes are data, not app styling, so the
// design-system literal scan doesn't apply. Pure + tested.

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

/** Linear sRGB channel mix of two #rrggbb hexes (`t` = 0 → `a`, 1 → `b`) —
 *  the TS twin of CSS `color-mix(in srgb, …)`. Exported for tests. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const ch = (shift: number) =>
    Math.round(((pa >> shift) & 0xff) * (1 - t) + ((pb >> shift) & 0xff) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** Build a MONOCHROME ANSI-16 from one accent: every slot is the accent mixed
 *  toward black (shades) or white (tints) — one hue, sixteen lightness steps.
 *  Normal colors ramp dark→light across slots 1–6 with the PURE accent at
 *  slot 4 (blue — the TUI's most common structural color); brights sit one
 *  step lighter than their normal twin; blacks/whites are deep-shade/near-
 *  white ends of the same ramp, so nothing in the terminal leaves the hue.
 *  Exported for tests. */
export function monoAnsi(accent: string): TermProfile["ansi"] {
  const shade = (t: number) => mixHex(accent, "#000000", t);
  const tint = (t: number) => mixHex(accent, "#ffffff", t);
  return [
    shade(0.82), // 0 black
    shade(0.45), // 1 red
    shade(0.3), // 2 green
    shade(0.15), // 3 yellow
    accent, // 4 blue — the pure identity color
    tint(0.18), // 5 magenta
    tint(0.36), // 6 cyan
    tint(0.55), // 7 white
    shade(0.6), // 8 bright black
    shade(0.3), // 9 bright red
    shade(0.15), // 10 bright green
    accent, // 11 bright yellow
    tint(0.18), // 12 bright blue
    tint(0.36), // 13 bright magenta
    tint(0.5), // 14 bright cyan
    tint(0.72), // 15 bright white
  ];
}

/** The palette's identity accent: its lightest color (shared logic with
 *  profileAccent, which resolves per-path). */
function accentOf(p: GlyphPalette): string {
  let best = p.colors[0] ?? "#ffffff";
  for (const c of p.colors) if (luminance(c) > luminance(best)) best = c;
  return best;
}

/** One terminal profile per glyph palette, same order as GLYPH_PALETTES —
 *  each a monochrome ramp of that palette's accent. */
export const TERM_PROFILES: TermProfile[] = GLYPH_PALETTES.map((p) => ({
  id: p.name,
  label: p.name.charAt(0).toUpperCase() + p.name.slice(1),
  ansi: monoAnsi(accentOf(p)),
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
