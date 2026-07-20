import { describe, expect, test } from "bun:test";
import { GLYPH_PALETTES, paletteFor } from "./identityGlyph";
import { profileAccent, profileFor, TERM_PROFILES } from "./termProfiles";

describe("terminal profiles", () => {
  test("one well-formed profile per glyph palette, colored slots in-family", () => {
    const HEX = /^#[0-9a-f]{6}$/i;
    expect(TERM_PROFILES.map((p) => p.id)).toEqual(GLYPH_PALETTES.map((p) => p.name));
    for (const [i, p] of TERM_PROFILES.entries()) {
      expect(p.ansi).toHaveLength(16);
      for (const c of p.ansi) expect(c).toMatch(HEX);
      // Colored slots (1–6, 9–14) all come from the matching glyph palette.
      const family = GLYPH_PALETTES[i]?.colors ?? [];
      for (const slot of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]) {
        expect(family).toContain(p.ansi[slot] as string);
      }
    }
  });

  test("assignment is stable and matches the glyph palette", () => {
    const path = "/repos/.app-worktrees/swift-harbor";
    expect(profileFor(path).id).toBe(profileFor(path).id);
    expect(profileFor(path).id).toBe(paletteFor(path).name);
  });

  test("accent is the glyph palette's lightest color", () => {
    const path = "/repos/.app-worktrees/swift-harbor";
    expect(paletteFor(path).colors).toContain(profileAccent(path));
  });
});
