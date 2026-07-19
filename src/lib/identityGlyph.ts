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

export interface GlyphPalette {
  name: string;
  colors: string[];
}

/** The glyph color palettes — every workspace is pinned to ONE (paletteFor),
 *  and its shapes pull their fills from it (shapeFills). */
export const GLYPH_PALETTES: GlyphPalette[] = [
  // magenta -> red-orange
  {
    name: "punch",
    colors: ["#e900d1", "#ff00b7", "#ff007a", "#ff003c", "#ff071e", "#ff180d", "#ff3f14"],
  },
  // orange -> yellow
  {
    name: "sun",
    colors: ["#FF6200", "#FF7700", "#FF8C00", "#FFA100", "#FFB700", "#FFCC00", "#FFE100"],
  },
  // teal-green -> chartreuse
  {
    name: "green",
    colors: ["#00cc8e", "#00de79", "#00f057", "#14ff00", "#6fff00", "#9bff00", "#bdff00"],
  },
  // deep blue -> cyan
  {
    name: "blue",
    colors: ["#0048ff", "#005fff", "#0075ff", "#008cff", "#00a3ff", "#00b9ff", "#00d0ff"],
  },
  // purple -> magenta
  {
    name: "violet",
    colors: ["#5f00db", "#7900ea", "#9500f8", "#b108ff", "#c817ff", "#de25ff", "#f134ff"],
  },
];

/** Deterministic 32-bit string hash (same scheme seededRand uses). */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** The workspace's palette: stable per seed, forever. */
export function paletteFor(seed: string): GlyphPalette {
  return GLYPH_PALETTES[hashSeed(seed) % GLYPH_PALETTES.length]!;
}

/** Fills for `count` shapes: a seeded-random pick from the palette per shape
 *  (the seed here is the GLYPH's — a morphing glyph re-rolls fills per tick). */
export function shapeFills(glyphSeed: string, count: number, palette: GlyphPalette): string[] {
  const rand = seededRand(`${glyphSeed}|fill`);
  const fills: string[] = [];
  for (let i = 0; i < count; i++)
    fills.push(palette.colors[Math.floor(rand() * palette.colors.length)] ?? "currentColor");
  return fills;
}

/** Deterministic 32-bit hash → [0,1) PRNG (mulberry32). */
function seededRand(seed: string): () => number {
  let a = hashSeed(seed) || 1;
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
