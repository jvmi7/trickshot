import { describe, expect, test } from "bun:test";
import { GLYPH_PALETTES, paletteFor } from "./identityGlyph";
import {
  mixHex,
  monoAnsi,
  monoExtended,
  profileAccent,
  profileFor,
  TERM_PROFILES,
} from "./termProfiles";

const HEX = /^#[0-9a-f]{6}$/i;

/** sRGB channel triple of a #rrggbb hex. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

describe("mixHex", () => {
  test("endpoints and midpoint", () => {
    expect(mixHex("#ff0000", "#000000", 0)).toBe("#ff0000");
    expect(mixHex("#ff0000", "#000000", 1)).toBe("#000000");
    expect(mixHex("#ff0000", "#000000", 0.5)).toBe("#800000");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});

describe("terminal profiles (monochrome)", () => {
  test("one well-formed profile per glyph palette", () => {
    expect(TERM_PROFILES.map((p) => p.id)).toEqual(GLYPH_PALETTES.map((p) => p.name));
    for (const p of TERM_PROFILES) {
      expect(p.ansi).toHaveLength(16);
      for (const c of p.ansi) expect(c).toMatch(HEX);
    }
  });

  test("every slot is a shade/tint of the SAME accent — no foreign hue", () => {
    // A black/white mix of `accent` keeps each channel between the accent's
    // value and the mix target (0 or 255): shades scale all channels by one
    // factor, tints move all channels toward 255 by one factor. Verify each
    // slot is expressible that way (single t across all three channels).
    for (const p of TERM_PROFILES) {
      const accent = p.ansi[4] as string; // slot 4 carries the pure accent
      const [ar, ag, ab] = rgb(accent);
      for (const slot of p.ansi) {
        const [r, g, b] = rgb(slot);
        // Recover the mix fraction per channel (guarding /0), then assert
        // they agree within rounding — one t means one hue family.
        const ts: number[] = [];
        const dark = r <= ar && g <= ag && b <= ab;
        const pairs: [number, number][] = [
          [r, ar],
          [g, ag],
          [b, ab],
        ];
        for (const [c, a] of pairs) {
          const denom = dark ? a : 255 - a;
          if (denom > 8) ts.push(dark ? 1 - c / denom : (c - a) / denom);
        }
        if (ts.length > 1) {
          // 8-bit rounding wobbles the recovered fraction a little; a foreign
          // hue would spread it by 0.2+.
          const spread = Math.max(...ts) - Math.min(...ts);
          expect(spread).toBeLessThan(0.05);
        }
      }
    }
  });

  test("the ramp spans dark to light with the accent as slot 4/11", () => {
    const lum = (hex: string) => {
      const [r, g, b] = rgb(hex);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const p of TERM_PROFILES) {
      const a = p.ansi;
      expect(a[11]).toBe(a[4] as string); // both carry the pure accent
      expect(lum(a[0] as string)).toBeLessThan(lum(a[4] as string)); // black < accent
      expect(lum(a[4] as string)).toBeLessThan(lum(a[15] as string)); // accent < bright white
      // Normals 1→6 are monotonically lighter (the lightness IS the semantics now).
      for (let i = 1; i < 6; i++) {
        expect(lum(a[i] as string)).toBeLessThanOrEqual(lum(a[i + 1] as string));
      }
    }
  });

  test("monoAnsi is pure over its accent", () => {
    expect(monoAnsi("#ff007a")).toEqual(monoAnsi("#ff007a"));
    expect(monoAnsi("#ff007a")[4]).toBe("#ff007a");
  });

  test("monoExtended covers slots 16–255 in-hue with luminance preserved", () => {
    const accent = "#00d0ff";
    const ext = monoExtended(accent);
    expect(ext).toHaveLength(240);
    for (const c of ext) expect(c).toMatch(HEX);
    const lum = (hex: string) => {
      const [r, g, b] = rgb(hex);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // The grayscale ramp (slots 232–255 → indices 216–239) stays monotonic —
    // the standard entries' lightness ordering survives the hue swap.
    for (let i = 217; i < 240; i++) {
      expect(lum(ext[i] as string)).toBeGreaterThanOrEqual(lum(ext[i - 1] as string));
    }
    // Cube black (slot 16) maps near-black; cube white (slot 231) near-white.
    expect(lum(ext[0] as string)).toBeLessThan(24);
    expect(lum(ext[231 - 16] as string)).toBeGreaterThan(232);
    // Cached per accent (same array identity on the second call).
    expect(monoExtended(accent)).toBe(ext);
  });

  test("assignment is stable and matches the glyph palette", () => {
    const path = "/repos/.app-worktrees/swift-harbor";
    expect(profileFor(path).id).toBe(profileFor(path).id);
    expect(profileFor(path).id).toBe(paletteFor(path).name);
  });

  test("accent is the glyph palette's lightest color and anchors the ramp", () => {
    const path = "/repos/.app-worktrees/swift-harbor";
    const accent = profileAccent(path);
    expect(paletteFor(path).colors).toContain(accent);
    // The terminal's pure-accent slot is exactly the sidebar swatch color.
    expect(profileFor(path).ansi[4]).toBe(accent);
  });
});
