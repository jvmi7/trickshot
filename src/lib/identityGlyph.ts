// Generative workspace identity glyphs: a 3×3 grid where some adjacent cells
// merge into pills (horizontal or vertical capsules) — every workspace gets a
// STABLE random-looking mark, seeded from its path. Pure + deterministic so
// it's unit-testable; IdentityGlyph.svelte renders the shapes as SVG.

export interface GlyphShape {
  /** Grid coords (0–2) and span in CELLS; the renderer scales to px. */
  col: number;
  row: number;
  w: number;
  h: number;
}

/** Deterministic 32-bit hash → [0,1) PRNG (mulberry32). */
function seededRand(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  let a = h || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The workspace's glyph: 3×3 cells, some merged into 2- or 3-cell pills.
 *  Same seed → same shapes, forever. Always fills the whole grid. */
export function glyphShapes(seed: string): GlyphShape[] {
  const rand = seededRand(seed);
  const used = [
    [false, false, false],
    [false, false, false],
    [false, false, false],
  ];
  const shapes: GlyphShape[] = [];
  let pills = 0;

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (used[row]?.[col]) continue;
      const roll = rand();
      const canRight = col < 2 && !used[row]?.[col + 1];
      const canRight2 = col === 0 && canRight && !used[row]?.[2];
      const canDown = row < 2 && !used[row + 1]?.[col];
      const canDown2 = row === 0 && canDown && !used[2]?.[col];
      let w = 1;
      let h = 1;
      // Merge probabilities tuned for "mostly dots, a pill or two per glyph".
      if (roll < 0.1 && canRight2) w = 3;
      else if (roll < 0.3 && canRight) w = 2;
      else if (roll < 0.38 && canDown2) h = 3;
      else if (roll < 0.55 && canDown) h = 2;
      if (w > 1 || h > 1) pills++;
      for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) used[r]![c] = true;
      shapes.push({ col, row, w, h });
    }
  }
  // All-dots rolls read as "the boring grid" — guarantee at least one pill by
  // merging the middle row's first two cells (deterministic, seed-independent
  // fallback shape).
  if (pills === 0) {
    const i = shapes.findIndex((s) => s.row === 1 && s.col === 0);
    const j = shapes.findIndex((s) => s.row === 1 && s.col === 1);
    if (i >= 0 && j >= 0) {
      shapes.splice(Math.max(i, j), 1);
      const first = shapes[Math.min(i, j)];
      if (first) first.w = 2;
    }
  }
  return shapes;
}
