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
    /** Track the mouse: each eye DEFORMS toward the cursor independently —
     *  it LEANS (a shear pivoting at its base), HOODS when looking down,
     *  OPENS taller when looking up, and the nearer eye deforms harder — so
     *  the two eyes take different shapes per cursor position (and converge
     *  cross-eyed when the cursor sits between them). Never translates. */
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
      const row: boolean[] = blank(PAD_X);
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
      row.push(...blank(PAD_X));
      out.push(row);
    }
    const padRow = () => blank(c + 2 * PAD_X);
    return [
      ...Array.from({ length: PAD_Y }, padRow),
      ...out,
      ...Array.from({ length: PAD_Y }, padRow),
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
  // What "looking" means for a solid wedge (no pupil, nothing to slide):
  // the shape DEFORMS — it never translates. Each eye owns a gaze:
  //   • lean — a horizontal SHEAR pivoting at the eye's BASE: the top edge
  //     swings toward the cursor while the bottom stays planted (an eye
  //     turning in its socket, not sliding across the face);
  //   • sv   — vertical scale ANCHORED AT THE BASE: looking down hoods the
  //     eye (lids lower), looking up opens it TALLER (the top rises into
  //     the padded headroom).
  // Computed per eye from ITS OWN screen center with distance attenuation,
  // so the nearer eye deforms harder — two different shapes per cursor
  // position, converging cross-eyed between them. Values are QUANTIZED
  // (1/8 lean steps / 0.05 scale steps) and written only on change, so
  // pointer motion recomputes the grid rarely, not per event.
  interface Gaze {
    /** Signed lean toward the cursor, -1..1 (quantized to eighths). */
    lean: number;
    /** Vertical scale about the base: hood < 1 < open. */
    sv: number;
  }
  const NEUTRAL: Gaze = { lean: 0, sv: 1 };
  /** Horizontal/vertical px offsets where the gaze saturates. */
  const GAZE_REACH_X = 260;
  const GAZE_REACH_Y = 220;
  /** Shear shape: every row leans at least BASE×lean; the top row adds the
   *  full SHEAR×lean on top (the pivot is the bottom row). */
  const LEAN_BASE = 1.5;
  const LEAN_SHEAR = 2.5;
  /** Looking down hoods to 1-HOOD; looking up opens to 1+OPEN. */
  const HOOD = 0.3;
  const OPEN = 0.12;
  /** Mask padding so no pose clips: max lean columns; open-stretch rows. */
  const PAD_X = 4;
  const PAD_Y = 2;
  let wrapEl = $state<HTMLDivElement | null>(null);
  let gazeL = $state<Gaze>(NEUTRAL);
  let gazeR = $state<Gaze>(NEUTRAL);

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const sameGaze = (a: Gaze, b: Gaze) => a.lean === b.lean && a.sv === b.sv;

  $effect(() => {
    if (!track) {
      gazeL = NEUTRAL;
      gazeR = NEUTRAL;
      return;
    }
    let raf = 0;
    let px = 0; // target (the real cursor)
    let py = 0;
    let sx = 0; // smoothed pursuit point — the eyes follow THIS
    let sy = 0;
    let seeded = false;
    let last = 0;
    /** Pursuit lag: the smoothed point closes the gap with ~this time
     *  constant — the eyes trail the cursor by a beat instead of snapping. */
    const PURSUIT_TAU_MS = 140;
    const step = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      const alpha = 1 - Math.exp(-dt / PURSUIT_TAU_MS);
      sx += (px - sx) * alpha;
      sy += (py - sy) * alpha;
      apply();
      // Keep chasing until the pursuit point has effectively arrived.
      if (Math.abs(px - sx) + Math.abs(py - sy) > 1.5) {
        raf = requestAnimationFrame(step);
      } else {
        last = 0;
      }
    };
    const apply = () => {
      const rect = wrapEl?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const cy = rect.top + rect.height / 2;
      const eye = (cx: number): Gaze => {
        // Nearer eye reacts harder: attenuate the deflection by distance.
        const gain = clamp(1.15 - Math.hypot(sx - cx, sy - cy) / 900, 0.45, 1);
        const nx = clamp((sx - cx) / GAZE_REACH_X, -1, 1) * gain;
        const ny = clamp((sy - cy) / GAZE_REACH_Y, -1, 1) * gain;
        return {
          lean: Math.round(nx * 8) / 8,
          sv:
            ny > 0
              ? Math.round((1 - HOOD * ny) * 20) / 20
              : Math.round((1 + OPEN * -ny) * 20) / 20,
        };
      };
      const nextL = eye(rect.left + rect.width * 0.25);
      const nextR = eye(rect.left + rect.width * 0.75);
      if (!sameGaze(nextL, gazeL)) gazeL = nextL;
      if (!sameGaze(nextR, gazeR)) gazeR = nextR;
    };
    // VELOCITY GATE, not a debounce: at a reasonable cursor speed the eyes
    // track continuously (the pursuit ease above IS the reaction time), but
    // a cursor FLYING across the screen isn't followed frame by frame — the
    // gaze holds until the smoothed velocity drops back under the gate. A
    // short stopped-timer catches the case where a fast flight simply ends
    // (no slow samples ever arrive) so the eyes still land on the rest point.
    const V_TRACK = 1.0; // px/ms — above this the cursor is "flying"
    const V_SMOOTH = 0.35; // EMA weight per sample (raw dt jitter is noisy)
    const STOP_COMMIT_MS = 90;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let lastMoveAt = 0;
    let lastMx = 0;
    let lastMy = 0;
    let vAvg = 0;
    const commit = (cx: number, cy: number) => {
      px = cx;
      py = cy;
      if (!raf) raf = requestAnimationFrame(step);
    };
    const move = (e: PointerEvent) => {
      const cx = e.clientX;
      const cy = e.clientY;
      const now = e.timeStamp;
      if (!seeded) {
        // First sighting: no lag on the very first pose (nothing to trail from).
        seeded = true;
        sx = cx;
        sy = cy;
        lastMoveAt = now;
        lastMx = cx;
        lastMy = cy;
        commit(cx, cy);
        return;
      }
      const dt = Math.max(1, now - lastMoveAt);
      const v = Math.hypot(cx - lastMx, cy - lastMy) / dt;
      vAvg += (v - vAvg) * V_SMOOTH;
      lastMoveAt = now;
      lastMx = cx;
      lastMy = cy;
      if (vAvg <= V_TRACK) commit(cx, cy);
      clearTimeout(settle);
      settle = setTimeout(() => {
        vAvg = 0; // events ceased — the cursor is at rest
        commit(cx, cy);
      }, STOP_COMMIT_MS);
    };
    const leave = () => {
      // Ease HOME rather than snapping: target the stage center (gaze = 0)
      // and let the pursuit loop carry the eyes back.
      const rect = wrapEl?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        px = rect.left + rect.width / 2;
        py = rect.top + rect.height / 2;
        if (!raf) raf = requestAnimationFrame(step);
      } else {
        gazeL = NEUTRAL;
        gazeR = NEUTRAL;
      }
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("mouseleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  });

  /** Warp one eye by its gaze — a per-cell inverse sample, no translation:
   *  rows scale vertically about the eye's BASE (the mark's bottom edge, so
   *  hooding lowers the top and opening raises it), and each row shears
   *  toward the cursor with the pivot at that same base (top swings most).
   *  Point sampling is safe both ways: compression skips source rows,
   *  stretching repeats them — never holes. */
  function warpEye(eye: Cell[][], gz: Gaze): Cell[][] {
    const rows = eye.length;
    if (rows === 0) return eye;
    const anchor = rows - 1 - PAD_Y; // the mark's bottom edge — the pivot
    const norm = Math.max(1, rows - 1);
    return eye.map((row, y) => {
      const ys = Math.round(anchor + (y - anchor) / gz.sv);
      const srcRow = eye[ys];
      if (!srcRow) return row.map(() => SPACE);
      const shift = Math.round(gz.lean * (LEAN_BASE + LEAN_SHEAR * (1 - y / norm)));
      if (shift === 0 && ys === y) return srcRow;
      return row.map((_, x) => {
        const c = srcRow[x - shift];
        return c && c.ch !== " " ? c : SPACE;
      });
    });
  }

  /** Apply each eye's gaze: each eye is ISOLATED by masking the other half
   *  (the mark's gap sits on the center column) but warped on the FULL-width
   *  canvas — so a convergent lean crosses the center seam and overlaps
   *  instead of clipping at the half boundary. Left wins overlaps. */
  function applyGaze(g: Cell[][], l: Gaze, r: Gaze): Cell[][] {
    const width = g[0]?.length ?? 0;
    const mid = Math.round(width / 2);
    const isolate = (keepLeft: boolean) =>
      g.map((row) => row.map((cell, x) => (x < mid === keepLeft ? cell : SPACE)));
    const left = warpEye(isolate(true), l);
    const right = warpEye(isolate(false), r);
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
