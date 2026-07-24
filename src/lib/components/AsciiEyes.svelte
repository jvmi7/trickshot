<script lang="ts">
  // ASCII rendition of the trickshot "eyes" brand mark — the TrickshotMark
  // paths rasterized to a character grid, shimmering with random glyphs from
  // the brand charset. Prop-driven primitive (no stores/api): the parent owns
  // color (currentColor) and type size (font-size: inherit — set a text-*
  // utility on the wrapper). The mask is sampled ONCE per geometry from an
  // offscreen canvas (the real SVG paths via Path2D, supersampled so the
  // wedge edges land cleanly); only the character roll runs per tick.
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

  let lines = $state<string[]>([]);
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

  /** One frame: inked cells keep their glyph or re-roll; the rest is space. */
  function roll(prev: string[] | null): string[] {
    return mask.map((row, y) =>
      row
        .map((on, x) => {
          if (!on) return " ";
          const kept = prev?.[y]?.[x];
          return kept && kept !== " " && Math.random() >= RE_ROLL ? kept : randChar();
        })
        .join(""),
    );
  }

  $effect(() => {
    mask = buildMask(cols, rowCount);
    lines = roll(null);
    const timer = setInterval(() => {
      lines = roll(lines);
    }, tickMs);
    return () => clearInterval(timer);
  });
</script>

<pre class="ascii-eyes {className ?? ''}" aria-hidden="true">{lines.join("\n")}</pre>

<style>
  /* Type geometry only — color and size come from the parent (currentColor
     + an inherited font-size). line-height 1 keeps the sampled aspect true. */
  .ascii-eyes {
    margin: 0;
    font-family: var(--font-mono);
    font-size: inherit;
    line-height: 1;
    letter-spacing: 0;
    user-select: none;
    white-space: pre;
  }
</style>
