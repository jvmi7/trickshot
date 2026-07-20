import { describe, expect, test } from "bun:test";
import { GLYPH_PALETTES, glyphShapes, paletteFor, shapeFills } from "./identityGlyph";

describe("glyphShapes", () => {
  test("deterministic per seed", () => {
    const a = glyphShapes("/repos/.x-worktrees/swift-harbor");
    const b = glyphShapes("/repos/.x-worktrees/swift-harbor");
    expect(a).toEqual(b);
  });

  test("covers the full 3x3 grid exactly once", () => {
    for (const seed of ["a", "b", "/w/one", "/w/two", "/w/three", "keen-fjord"]) {
      const cells = new Set<string>();
      for (const s of glyphShapes(seed)) {
        for (let r = s.row; r < s.row + s.h; r++) {
          for (let c = s.col; c < s.col + s.w; c++) {
            const key = `${r},${c}`;
            expect(cells.has(key)).toBe(false); // no overlap
            cells.add(key);
          }
        }
      }
      expect(cells.size).toBe(9); // no gaps
    }
  });

  test("always contains at least one pill", () => {
    for (let i = 0; i < 50; i++) {
      const shapes = glyphShapes(`seed-${i}`);
      expect(shapes.some((s) => s.w > 1 || s.h > 1)).toBe(true);
    }
  });

  test("different seeds usually differ", () => {
    const sigs = new Set(
      ["/a", "/b", "/c", "/d", "/e", "/f"].map((s) => JSON.stringify(glyphShapes(s))),
    );
    expect(sigs.size).toBeGreaterThan(3);
  });
});

describe("palettes", () => {
  test("paletteFor is deterministic and in-registry", () => {
    const p = paletteFor("/repos/.x-worktrees/swift-harbor");
    expect(p).toBe(paletteFor("/repos/.x-worktrees/swift-harbor"));
    expect(GLYPH_PALETTES).toContain(p);
  });

  test("shapeFills returns one in-palette color per shape", () => {
    for (const palette of GLYPH_PALETTES) {
      const fills = shapeFills("seed#3", 7, palette);
      expect(fills.length).toBe(7);
      for (const f of fills) expect(palette.colors).toContain(f);
    }
  });

  test("fills are deterministic per glyph seed and re-roll across seeds", () => {
    const punch = GLYPH_PALETTES.find((p) => p.name === "punch");
    if (!punch) throw new Error("punch palette missing");
    expect(shapeFills("s#1", 9, punch)).toEqual(shapeFills("s#1", 9, punch));
    const sigs = new Set(
      [1, 2, 3, 4, 5].map((t) => JSON.stringify(shapeFills(`s#${t}`, 9, punch))),
    );
    expect(sigs.size).toBeGreaterThan(1);
  });
});
