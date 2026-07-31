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
  // red -> warm orange
  {
    name: "ember",
    colors: ["#d61a00", "#e62e00", "#f54200", "#ff5610", "#ff6a26", "#ff7e3c", "#ff9252"],
  },
  // deep rose -> pink
  {
    name: "rose",
    colors: ["#d10045", "#e00d5c", "#ef1a73", "#ff278a", "#ff3ba1", "#ff4fb8", "#ff63cf"],
  },
  // blood red -> coral
  {
    name: "coral",
    colors: ["#c41230", "#d3243c", "#e23648", "#f14854", "#ff5a60", "#ff6c6c", "#ff7e78"],
  },
  // amber -> gold
  {
    name: "gold",
    colors: ["#c77400", "#d68200", "#e59000", "#f49e00", "#ffac0f", "#ffba2e", "#ffc84d"],
  },
  // chartreuse -> lemon
  {
    name: "citrus",
    colors: ["#7fbf00", "#93cc00", "#a7d900", "#bbe600", "#cff300", "#e3ff0f", "#f7ff3d"],
  },
  // deep green -> mint
  {
    name: "mint",
    colors: ["#00a05a", "#00b26b", "#00c47c", "#00d68d", "#0fe89e", "#2effb5", "#5cffc9"],
  },
  // forest -> spring green
  {
    name: "spring",
    colors: ["#0f9e00", "#23ad0f", "#37bc1e", "#4bcb2d", "#5fda3c", "#73e94b", "#87f85a"],
  },
  // teal -> aqua
  {
    name: "aqua",
    colors: ["#008c8c", "#009e9e", "#00b0b0", "#00c2c2", "#00d4d4", "#0fe6e6", "#3df8f0"],
  },
  // ocean blue -> sky
  {
    name: "sky",
    colors: ["#0064c8", "#0f76d7", "#1e88e6", "#2d9af5", "#3cacff", "#5cbeff", "#7ad0ff"],
  },
  // glacier -> pale ice blue
  {
    name: "ice",
    colors: ["#4dc3ff", "#61cbff", "#75d3ff", "#89dbff", "#9de3ff", "#b1ebff", "#c5f3ff"],
  },
  // midnight -> periwinkle
  {
    name: "peri",
    colors: ["#2e3cff", "#4350ff", "#5864ff", "#6d78ff", "#828cff", "#97a0ff", "#acb4ff"],
  },
  // indigo -> lavender
  {
    name: "lavender",
    colors: ["#6a2eff", "#7d43ff", "#9058ff", "#a36dff", "#b682ff", "#c997ff", "#dcacff"],
  },
  // electric fuchsia -> orchid pink
  {
    name: "fuchsia",
    colors: ["#b400c8", "#c80ed7", "#dc1ce6", "#f02af5", "#ff38ff", "#ff52ff", "#ff6cff"],
  },
  // salmon -> peach
  {
    name: "peach",
    colors: ["#ff5a3c", "#ff6a4a", "#ff7a58", "#ff8a66", "#ff9a74", "#ffaa82", "#ffba90"],
  },
  // bronze -> sand
  {
    name: "sand",
    colors: ["#b98a2e", "#c69a3c", "#d3aa4a", "#e0ba58", "#edca66", "#fada74", "#ffea8c"],
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
