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
    blink = true,
    track = true,
    class: className,
  }: {
    /** Grid width in characters (height follows the mark's aspect). */
    cols?: number;
    charset?: string;
    /** Shimmer cadence — each tick re-rolls ~a third of the inked cells. */
    tickMs?: number;
    /** Blink every few seconds: the top and bottom halves close in at the
     *  same rate and meet as a single line at the vertical middle. */
    blink?: boolean;
    /** Track the mouse: each eye deforms toward the cursor INDEPENDENTLY —
     *  its glyph mass shifts toward the target, it hoods (partial squash)
     *  when looking down, and the nearer eye deflects harder — so the two
     *  eyes take different shapes per cursor position (and converge
     *  cross-eyed when the cursor sits between them). */
    track?: boolean;
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
   *  bucket coverage per character cell. The result is PADDED by the maximum
   *  gaze shift on every side — the mark fills its sampled box nearly
   *  edge-to-edge, so an unpadded grid would clip any lean/drop (eyes "cut
   *  off"); the margin gives every shift headroom. */
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
    const blank = (n: number) => Array.from({ length: n }, () => false);
    for (let y = 0; y < r; y++) {
      const row: boolean[] = blank(GAZE_MAX_DX);
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
      row.push(...blank(GAZE_MAX_DX));
      out.push(row);
    }
    const padRow = () => blank(c + 2 * GAZE_MAX_DX);
    return [
      ...Array.from({ length: GAZE_MAX_DY }, padRow),
      ...out,
      ...Array.from({ length: GAZE_MAX_DY }, padRow),
    ];
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

  // ---- The blink, frame by frame ----
  // Each frame is a vertical SQUASH of the open grid toward the center line:
  // display row y shows the union of the source rows its band covers at
  // squash factor s (1 = open), so the top and bottom halves close in at the
  // SAME rate and meet in the middle. s = 0 is the fully-shut frame — one
  // line at the center carrying the eyes' full horizontal silhouette (the
  // vertical projection). Chars/colors ride along from the open grid, so the
  // art visibly compresses rather than being redrawn.
  // A real blink is NOT linear: the lids SNAP shut (accelerating, ~100ms),
  // rest closed a beat, then reopen at half the speed (decelerating into
  // fully open). Each keyframe carries its own hold time (`ms` = how long
  // this squash shows before the next frame).
  const BLINK_KEYFRAMES: { s: number; ms: number }[] = [
    { s: 0.7, ms: 18 }, // the lid snaps…
    { s: 0.3, ms: 12 }, // …accelerating shut
    { s: 0, ms: 45 }, // shut — the hold beat
    { s: 0.25, ms: 22 }, // reopening, quick off the line
    { s: 0.55, ms: 30 }, // …decelerating…
    { s: 0.85, ms: 42 }, // …settling into open
  ];
  const BLINK_GAP_MIN_MS = 2600;
  const BLINK_GAP_JITTER_MS = 3800;
  let squash = $state(1);

  function squashGrid(g: Cell[][], s: number): Cell[][] {
    const rows = g.length;
    if (rows === 0) return g;
    const center = (rows - 1) / 2;
    // Shut (or shut enough that one band covers everything): the single line.
    if (s <= 1 / rows) {
      const lineY = Math.round(center);
      return g.map((row, y) =>
        y === lineY
          ? row.map((_, x) => {
              for (const src of g) {
                const cell = src[x];
                if (cell && cell.ch !== " ") return cell;
              }
              return SPACE;
            })
          : row.map(() => SPACE),
      );
    }
    return g.map((row, y) => {
      const lo = center + (y - 0.5 - center) / s;
      const hi = center + (y + 0.5 - center) / s;
      const y0 = Math.max(0, Math.ceil(lo));
      const y1 = Math.min(rows - 1, Math.floor(hi));
      if (y0 > y1) return row.map(() => SPACE);
      return row.map((_, x) => {
        for (let yy = y0; yy <= y1; yy++) {
          const cell = g[yy]?.[x];
          if (cell && cell.ch !== " ") return cell;
        }
        return SPACE;
      });
    });
  }

  // ---- Cursor tracking (the gaze) ----
  // Each eye owns a gaze: dx/dy = whole-cell shift toward the cursor, sv =
  // vertical squash (looking DOWN hoods the eye; up stays open). Computed
  // per eye from ITS OWN screen center with distance attenuation, so the
  // nearer eye deflects harder — two different shapes per cursor position.
  // Values are QUANTIZED (whole cells / 0.05 squash steps) and written only
  // on change, so pointer motion recomputes the grid rarely, not per event.
  interface Gaze {
    dx: number;
    dy: number;
    sv: number;
  }
  const NEUTRAL: Gaze = { dx: 0, dy: 0, sv: 1 };
  /** Horizontal/vertical px offsets where the gaze saturates. */
  const GAZE_REACH_X = 260;
  const GAZE_REACH_Y = 220;
  const GAZE_MAX_DX = 3;
  const GAZE_MAX_DY = 2;
  /** How hard looking down hoods the eye (sv floor = 1 - this). */
  const HOOD = 0.35;
  let wrapEl = $state<HTMLDivElement | null>(null);
  let gazeL = $state<Gaze>(NEUTRAL);
  let gazeR = $state<Gaze>(NEUTRAL);

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const sameGaze = (a: Gaze, b: Gaze) => a.dx === b.dx && a.dy === b.dy && a.sv === b.sv;

  $effect(() => {
    if (!track) {
      gazeL = NEUTRAL;
      gazeR = NEUTRAL;
      return;
    }
    let raf = 0;
    let px = 0;
    let py = 0;
    const apply = () => {
      raf = 0;
      const rect = wrapEl?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const cy = rect.top + rect.height / 2;
      const eye = (cx: number): Gaze => {
        // Nearer eye reacts harder: attenuate the deflection by distance.
        const gain = clamp(1.15 - Math.hypot(px - cx, py - cy) / 900, 0.45, 1);
        const nx = clamp((px - cx) / GAZE_REACH_X, -1, 1) * gain;
        const ny = clamp((py - cy) / GAZE_REACH_Y, -1, 1) * gain;
        return {
          dx: Math.round(nx * GAZE_MAX_DX),
          dy: Math.round(ny * GAZE_MAX_DY),
          sv: ny > 0 ? Math.round((1 - HOOD * ny) * 20) / 20 : 1,
        };
      };
      const nextL = eye(rect.left + rect.width * 0.25);
      const nextR = eye(rect.left + rect.width * 0.75);
      if (!sameGaze(nextL, gazeL)) gazeL = nextL;
      if (!sameGaze(nextR, gazeR)) gazeR = nextR;
    };
    const move = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const leave = () => {
      gazeL = NEUTRAL;
      gazeR = NEUTRAL;
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("mouseleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
      cancelAnimationFrame(raf);
    };
  });

  /** Whole-cell translate; vacated cells go blank, shifted-out cells clip. */
  function shiftGrid(g: Cell[][], dx: number, dy: number): Cell[][] {
    if (dx === 0 && dy === 0) return g;
    return g.map((row, y) =>
      row.map((_, x) => {
        const src = g[y - dy]?.[x - dx];
        return src && src.ch !== " " ? src : SPACE;
      }),
    );
  }

  /** Apply each eye's gaze: each eye is ISOLATED by masking the other half
   *  (the mark's gap sits on the center column) but transformed on the
   *  FULL-width canvas — so a convergent lean crosses the center seam and
   *  overlaps instead of clipping at the half boundary. Left wins overlaps. */
  function applyGaze(g: Cell[][], l: Gaze, r: Gaze): Cell[][] {
    const width = g[0]?.length ?? 0;
    const mid = Math.round(width / 2);
    const isolate = (keepLeft: boolean) =>
      g.map((row) => row.map((cell, x) => (x < mid === keepLeft ? cell : SPACE)));
    const transform = (eye: Cell[][], gz: Gaze) =>
      shiftGrid(gz.sv < 1 ? squashGrid(eye, gz.sv) : eye, gz.dx, gz.dy);
    const left = transform(isolate(true), l);
    const right = transform(isolate(false), r);
    return g.map((row, y) =>
      row.map((_, x) => {
        const lc = left[y]?.[x];
        if (lc && lc.ch !== " ") return lc;
        const rc = right[y]?.[x];
        return rc && rc.ch !== " " ? rc : SPACE;
      }),
    );
  }

  /** What actually renders: base grid → per-eye gaze → the blink frame. */
  const display = $derived.by(() => {
    const gazed =
      sameGaze(gazeL, NEUTRAL) && sameGaze(gazeR, NEUTRAL) ? grid : applyGaze(grid, gazeL, gazeR);
    return squash >= 1 ? gazed : squashGrid(gazed, squash);
  });

  $effect(() => {
    if (!blink) {
      squash = 1;
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(play, BLINK_GAP_MIN_MS + Math.random() * BLINK_GAP_JITTER_MS);
    };
    const play = () => {
      let i = 0;
      const step = () => {
        const frame = BLINK_KEYFRAMES[i++];
        if (!frame) {
          squash = 1;
          schedule();
          return;
        }
        squash = frame.s;
        timer = setTimeout(step, frame.ms);
      };
      step();
    };
    schedule();
    return () => clearTimeout(timer);
  });
</script>

<div class="ascii-eyes {className ?? ''}" aria-hidden="true" bind:this={wrapEl}>
  <!-- Two whitespace landmines, both defused here: (1) each row's cells MUST
       be one unbroken template line — Svelte keeps a single space around
       inline elements split across source lines, which white-space: pre
       would render; (2) uninked cells MUST be the {" "} EXPRESSION — a
       literal space in markup is whitespace-only text the compiler TRIMS,
       which collapsed the mask's gaps into a centered blob. (Biome doesn't
       format .svelte — the long line survives.) Colors are dynamic runtime
       values, not source literals. -->
  {#each display as row, y (y)}
    <!-- prettier-ignore -->
    <div class="ascii-row">{#each row as cell, x (x)}{#if cell.ch === " "}<span>{" "}</span>{:else}<span style="color: {cell.color}">{cell.ch}</span>{/if}{/each}</div>
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
    /* The hero centers text; a masked row must keep its leading spaces
       meaningful — left-anchor the glyph grid regardless of the parent. */
    text-align: left;
  }
</style>
