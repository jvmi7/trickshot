<script lang="ts">
  // ASCII rendition of the trickshot "eyes" brand mark — the TrickshotMark
  // paths rasterized to a character grid, shimmering with random glyphs from
  // the brand charset, EACH CELL in its own random hex color (random hue at
  // vivid saturation/lightness — a fully random RGB goes muddy on the dark
  // canvas). Prop-driven primitive (no stores/api): the parent owns type size
  // (font-size: inherit — set a text-* utility on the wrapper). The mask is
  // sampled ONCE per geometry from an offscreen canvas (the real SVG paths
  // via Path2D, supersampled so the wedge edges land cleanly); only the
  // character/color roll runs per tick.
  let {
    cols = 56,
    charset = "%#!&TRCKSHOT",
    tickMs = 120,
    class: className,
  }: {
    /** Grid width in characters (height follows the mark's aspect). */
    cols?: number;
    charset?: string;
    /** Shimmer cadence — each tick re-rolls ~a third of the inked cells. */
    tickMs?: number;
    class?: string;
  } = $props();

  // The SAME geometry as TrickshotMark.svelte (the app's own mark, duplicated
  // here as data because this component samples it rather than rendering it).
  const VIEW_W = 44;
  const VIEW_H = 16;
  const EYE_PATHS = [
    "M5.36029 14.5693C10.4862 17.5145 17.0406 15.7667 20 10.6655L1.4376 0C-1.52182 5.10122 0.234427 11.6241 5.36029 14.5693Z",
    "M38.6397 14.5693C33.5138 17.5145 26.9594 15.7667 24 10.6655L42.5624 0C45.5218 5.10122 43.7656 11.6241 38.6397 14.5693Z",
  ];

  /** A monospace cell is ~half as wide as it is tall — squash the row count
   *  so the rendered mark keeps the SVG's aspect. */
  const CHAR_ASPECT = 0.5;
  const rowCount = $derived(Math.max(4, Math.round(cols * (VIEW_H / VIEW_W) * CHAR_ASPECT)));

  /** Which fraction of inked cells re-roll per tick — full re-rolls strobe;
   *  a third reads as a live shimmer. */
  const RE_ROLL = 0.34;
  /** A cell is inked when at least this share of its supersamples hit path. */
  const COVERAGE = 0.35;

  /** One inked cell: its glyph + its own random color ("" = uninked space). */
  interface Cell {
    ch: string;
    color: string;
  }

  let grid = $state<Cell[][]>([]);
  let mask: boolean[][] = [];

  /** Rasterize the mark: fill the real paths on a supersampled canvas, then
   *  bucket coverage per character cell. */
  function buildMask(c: number, r: number): boolean[][] {
    if (typeof document === "undefined") return [];
    const SS = 4;
    const canvas = document.createElement("canvas");
    canvas.width = c * SS;
    canvas.height = r * SS;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    ctx.scale((c * SS) / VIEW_W, (r * SS) / VIEW_H);
    for (const d of EYE_PATHS) ctx.fill(new Path2D(d));
    const img = ctx.getImageData(0, 0, c * SS, r * SS).data;
    const out: boolean[][] = [];
    for (let y = 0; y < r; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < c; x++) {
        let hits = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * c * SS + x * SS + sx) * 4 + 3; // alpha
            if ((img[i] ?? 0) > 127) hits++;
          }
        }
        row.push(hits / (SS * SS) >= COVERAGE);
      }
      out.push(row);
    }
    return out;
  }

  function randChar(): string {
    return charset[Math.floor(Math.random() * charset.length)] ?? "#";
  }

  /** A random VIVID hex color: random hue, high saturation, mid-high
   *  lightness — every roll reads on the dark canvas. */
  function randColor(): string {
    const h = Math.random() * 360;
    const s = 0.75 + Math.random() * 0.25;
    const l = 0.55 + Math.random() * 0.15;
    // hsl → hex (standard conversion, c/x/m form)
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      h < 60
        ? [c, x, 0]
        : h < 120
          ? [x, c, 0]
          : h < 180
            ? [0, c, x]
            : h < 240
              ? [0, x, c]
              : h < 300
                ? [x, 0, c]
                : [c, 0, x];
    const hex = (v: number) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  const SPACE: Cell = { ch: " ", color: "" };

  /** One frame: inked cells keep their glyph+color or re-roll both. */
  function roll(prev: Cell[][] | null): Cell[][] {
    return mask.map((row, y) =>
      row.map((on, x) => {
        if (!on) return SPACE;
        const kept = prev?.[y]?.[x];
        return kept && kept.ch !== " " && Math.random() >= RE_ROLL
          ? kept
          : { ch: randChar(), color: randColor() };
      }),
    );
  }

  $effect(() => {
    mask = buildMask(cols, rowCount);
    grid = roll(null);
    const timer = setInterval(() => {
      grid = roll(grid);
    }, tickMs);
    return () => clearInterval(timer);
  });
</script>

<div class="ascii-eyes {className ?? ''}" aria-hidden="true">
  <!-- Each row's cells MUST be one unbroken template line: Svelte keeps a
       single space around inline elements split across source lines, and
       under white-space: pre those phantom spaces widen every cell and
       garble the sampled shape. (Biome doesn't format .svelte — the long
       line survives.) Colors are dynamic runtime values, not source
       literals. -->
  {#each grid as row, y (y)}
    <!-- prettier-ignore -->
    <div class="ascii-row">{#each row as cell, x (x)}{#if cell.ch === " "}<span> </span>{:else}<span style="color: {cell.color}">{cell.ch}</span>{/if}{/each}</div>
  {/each}
</div>

<style>
  /* Type geometry only — size comes from the parent (inherited font-size).
     line-height 1 keeps the sampled aspect true. */
  .ascii-eyes {
    font-family: var(--font-mono);
    font-size: inherit;
    line-height: 1;
    letter-spacing: 0;
    user-select: none;
  }
  .ascii-row {
    white-space: pre;
  }
</style>
