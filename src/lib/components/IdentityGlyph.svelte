<script lang="ts">
  // Workspace identity mark: the seeded 3×3 blob glyph (identityGlyph.ts) as
  // an SVG, tinted by `color`. Prop-driven primitive (no stores/api). This is
  // a GENERATIVE mark, not an icon — no Lucide equivalent exists, hence the
  // deliberate hand-drawn SVG (the icons-are-Lucide-only rule targets icons).
  //
  // `loading` morphs the mark through RANDOM glyphs: vanishing shapes shrink
  // away first, survivors stretch to their new geometry next, and each NEW
  // shape grows in the moment its space frees up (see the choreography
  // effect). The svg renders a FIXED set of per-cell rect slots (see AXIS
  // PURITY) so everything animates geometry instead of swapping nodes — SVG
  // rect x/y/width/height/rx are CSS-transitionable.
  import { glyphShapes, paletteFor, shapeFills } from "../identityGlyph";

  let {
    seed,
    color,
    size = 12,
    loading = false,
    dots = false,
    mono = false,
  }: {
    seed: string;
    /** The identity accent — now only the currentColor fallback for collapsed
     *  bars; visible shapes pull their fills from the seed's palette. */
    color: string;
    /** Rendered square size in px. */
    size?: number;
    /** Morph through random glyphs (the busy indicator). */
    loading?: boolean;
    /** Decompose every shape into single-cell DOTS (no pills) — the same
     *  generative layout, dot-grid rendering (the sidebar trickshot mark). */
    dots?: boolean;
    /** One color for every element (currentColor) instead of palette fills. */
    mono?: boolean;
  } = $props();

  const CELL = 4; // viewBox units per grid cell
  // Optical compensation: circles at the same bounding height as bars READ
  // smaller (less edge area), so single dots overshoot with a tighter inset.
  const INSET = 0.7; // pills
  const INSET_DOT = 0.45; // single dots — slightly larger than geometric parity
  const PHASE_MS = 250; // one tween: a vanish, a stretch, or an appearance
  const HOLD_MS = 450; // rest after a full cycle — the glyph settles

  interface Slot {
    key: string;
    x: number;
    y: number;
    w: number;
    h: number;
    rx: number;
    /** Uniform scale about the shape's own center — dots vanish/appear by
     *  scaling to/from 0 (never an axis squish); pills keep sc = 1. */
    sc: number;
    /** transition-delay (ms) — schedules this slot's tween on the cycle
     *  timeline (appearances fire when their space becomes vacant). */
    delay: number;
    /** Fill color, pulled from the workspace's glyph palette. */
    fill: string;
  }
  const PILL_THICK = CELL - INSET * 2; // a pill's cross-axis thickness

  /** Slot index for a cell+axis; slots are emitted h,v per cell in row-major
   *  order, so this is the shared indexing scheme for all slot arrays. */
  const slotIndex = (row: number, col: number, home: "h" | "v") =>
    (row * 3 + col) * 2 + (home === "h" ? 0 : 1);

  /** The collapsed (invisible) axis bar for slot i: full cross-axis
   *  thickness, zero length, centered in its own cell. */
  function barFor(i: number): Slot {
    const cell = Math.floor(i / 2);
    const row = Math.floor(cell / 3);
    const col = cell % 3;
    const cx = col * CELL + CELL / 2;
    const cy = row * CELL + CELL / 2;
    return i % 2 === 0
      ? {
          key: `${row},${col}h`,
          x: cx,
          y: cy - PILL_THICK / 2,
          w: 0,
          h: PILL_THICK,
          rx: PILL_THICK / 2,
          sc: 1,
          delay: 0,
          fill: "currentColor",
        }
      : {
          key: `${row},${col}v`,
          x: cx - PILL_THICK / 2,
          y: cy,
          w: PILL_THICK,
          h: 0,
          rx: PILL_THICK / 2,
          sc: 1,
          delay: 0,
          fill: "currentColor",
        };
  }

  // The morph's memory between glyphs: which rect ("h" | "v") currently holds
  // each cell's shape. Deliberately NON-reactive — it's consumed only inside
  // computeSlots, which runs once per new glyph.
  const homes = new Map<string, "h" | "v">();

  /** A shape's home axis: pills live on their own axis, dots stay wherever
   *  they last were (falling back to "h"). */
  const homeOf = (s: { row: number; col: number; w: number; h: number }, map: Map<string, "h" | "v">) =>
    s.h > 1 ? "v" : s.w > 1 ? "h" : (map.get(`${s.row},${s.col}`) ?? "h");

  // AXIS PURITY: every grid cell renders TWO rects — one that only ever
  // stretches horizontally, one only vertically. A pill lives in the rect of
  // its own axis; a dot stays wherever it last was (so pill→dot keeps
  // shrinking along the pill's axis). An orientation flip is therefore "one
  // rect collapses + the other grows" — never a diagonal tween through a
  // squarish in-between. Collapsed rects keep full cross-axis thickness and
  // zero length (w or h = 0 paints nothing), so a PILL appears/disappears as
  // a single-axis wipe; DOTS instead scale to/from 0 about their center (the
  // `sc` field). Nothing ever slides across the glyph.
  function computeSlots(glyphSeed: string): Slot[] {
    // dots mode: every shape decomposes into its covered cells as 1×1 dots —
    // the same seeded layout, rendered as a dot grid (pills never form).
    const shapes = dots
      ? glyphShapes(glyphSeed).flatMap((s) =>
          Array.from({ length: s.w * s.h }, (_, i) => ({
            col: s.col + (i % s.w),
            row: s.row + Math.floor(i / s.w),
            w: 1,
            h: 1,
          })),
        )
      : glyphShapes(glyphSeed);
    // Fills come from the WORKSPACE's palette (stable per `seed`) but re-roll
    // per glyph tick, so a morphing mark also cycles its colors — unless
    // mono, where every element rides currentColor (the parent's tone).
    const fills = mono
      ? shapes.map(() => "currentColor")
      : shapeFills(glyphSeed, shapes.length, paletteFor(seed));
    const byOrigin = new Map(shapes.map((s, i) => [`${s.row},${s.col}`, { s, fill: fills[i] ?? "currentColor" }]));
    const out: Slot[] = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const key = `${row},${col}`;
        const hit = byOrigin.get(key);
        const s = hit?.s;
        if (!s) homes.delete(key);
        const home = s ? homeOf(s, homes) : "h";
        if (s) homes.set(key, home);

        let hSlot = barFor(slotIndex(row, col, "h"));
        let vSlot = barFor(slotIndex(row, col, "v"));
        if (s && hit) {
          const inset = s.w === 1 && s.h === 1 ? INSET_DOT : INSET;
          const w = s.w * CELL - inset * 2;
          const h = s.h * CELL - inset * 2;
          const geo = {
            x: s.col * CELL + inset,
            y: s.row * CELL + inset,
            w,
            h,
            rx: Math.min(w, h) / 2,
            sc: 1,
            delay: 0,
            fill: hit.fill,
          };
          if (home === "h") hSlot = { ...hSlot, ...geo };
          else vSlot = { ...vSlot, ...geo };
        }
        out.push(hSlot, vSlot);
      }
    }
    return out;
  }

  const visible = (s: Slot) => s.w > 0 && s.h > 0 && s.sc > 0;
  // Only dots are square; pills and collapsed bars never are.
  const isDot = (s: Slot) => s.w === s.h;

  /** Where in a linear tween from→to does the rect first stop overlapping
   *  cell (r, c)? Fraction in [0, 1]; 1 = only clear at the very end. */
  function exitFraction(from: Slot, to: Slot, r: number, c: number): number {
    const cellL = c * CELL;
    const cellR = cellL + CELL;
    const cellT = r * CELL;
    const cellB = cellT + CELL;
    const fs: number[] = [];
    const oldR = from.x + from.w;
    const newR = to.x + to.w;
    if (oldR > cellL && newR <= cellL) fs.push((oldR - cellL) / (oldR - newR));
    if (from.x < cellR && to.x >= cellR) fs.push((cellR - from.x) / (to.x - from.x));
    const oldB = from.y + from.h;
    const newB = to.y + to.h;
    if (oldB > cellT && newB <= cellT) fs.push((oldB - cellT) / (oldB - newB));
    if (from.y < cellB && to.y >= cellB) fs.push((cellB - from.y) / (to.y - from.y));
    return fs.length ? Math.max(0, Math.min(1, Math.min(...fs))) : 1;
  }

  // The rendered slot geometry — mirrored in a plain variable so the loading
  // effect can read "what's on screen" without depending on its own writes.
  // The initial-seed capture is deliberate: it's just the first paint; the
  // effect below re-syncs whenever seed/loading change.
  // svelte-ignore state_referenced_locally
  let rendered = computeSlots(seed);
  let slots = $state(rendered);
  function show(next: Slot[]) {
    rendered = next;
    slots = next;
  }

  // CHOREOGRAPHY per cycle — one show() with per-slot transition-delays:
  //   • vanish  — shapes with no successor shrink away, starting at 0
  //   • stretch — survivors tween to their new geometry after the vanish
  //   • appear  — each new shape grows in AT THE MOMENT its space frees up:
  //     we solve, per cell it covers, when the old covering shape's edge
  //     clears that cell (exitFraction over its linear tween) and delay the
  //     appearance to the LAST of those vacancies. Appearances are therefore
  //     reactive to the surrounding motion, not locked to a global phase.
  // Appearing shapes are pre-anchored INVISIBLY at their start form (dot at
  // scale 0, pill as its axis bar), painted one frame before targets land.
  $effect(() => {
    if (!loading) {
      show(computeSlots(seed));
      return;
    }
    let t = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    let prevGlyphSeed = seed;
    const after = (ms: number, fn: () => void) => {
      timer = setTimeout(fn, ms);
    };
    const cycle = () => {
      t += 1;
      const glyphSeed = `${seed}#${t}`;
      const oldShapes = glyphShapes(prevGlyphSeed);
      const oldHomes = new Map(homes);
      const oldSlots = rendered;
      const next = computeSlots(glyphSeed);
      prevGlyphSeed = glyphSeed;

      const anyVanish = next.some((n, i) => {
        const o = oldSlots[i];
        return o && visible(o) && !visible(n);
      });
      const stretchStart = anyVanish ? PHASE_MS : 0;

      // When does each grid cell become VACANT on the cycle timeline?
      const vacantAt = new Map<string, number>();
      for (const o of oldShapes) {
        const k = slotIndex(o.row, o.col, homeOf(o, oldHomes));
        const from = oldSlots[k];
        const to = next[k];
        if (!from || !to) continue;
        const gone = !visible(to);
        const start = gone ? 0 : stretchStart;
        for (let r = o.row; r < o.row + o.h; r++) {
          for (let c = o.col; c < o.col + o.w; c++) {
            // A vanishing dot holds its cell until its scale-out completes.
            const f = gone && isDot(from) ? 1 : exitFraction(from, to, r, c);
            vacantAt.set(`${r},${c}`, start + f * PHASE_MS);
          }
        }
      }

      // Appear delay = the LAST vacancy among the cells the new shape covers.
      const appearDelay = new Map<number, number>();
      for (const n of glyphShapes(glyphSeed)) {
        const k = slotIndex(n.row, n.col, homeOf(n, homes));
        const o = oldSlots[k];
        if (o && visible(o)) continue; // survivor, not an appearance
        let d = 0;
        for (let r = n.row; r < n.row + n.h; r++)
          for (let c = n.col; c < n.col + n.w; c++) d = Math.max(d, vacantAt.get(`${r},${c}`) ?? 0);
        appearDelay.set(k, d);
      }

      const final = next.map((n, i) => {
        const o = oldSlots[i] ?? n;
        if (visible(o) && !visible(n))
          return isDot(o) ? { ...o, sc: 0, delay: 0 } : { ...n, fill: o.fill, delay: 0 };
        if (visible(o)) return { ...n, delay: stretchStart };
        if (visible(n)) return { ...n, delay: appearDelay.get(i) ?? stretchStart + PHASE_MS };
        return { ...n, delay: 0 };
      });
      const anchor = oldSlots.map((o, i) => {
        const n = next[i];
        const d = final[i]?.delay ?? 0;
        if (n && !visible(o) && visible(n))
          return isDot(n) ? { ...n, sc: 0, delay: d } : { ...barFor(i), fill: n.fill, delay: d };
        return { ...o, delay: d };
      });

      show(anchor);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => show(final));
      });
      const maxDelay = final.reduce((m, s) => Math.max(m, s.delay), 0);
      after(maxDelay + PHASE_MS + HOLD_MS, cycle);
    };
    after(HOLD_MS, cycle);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  });
</script>

<svg
  class="ident-glyph"
  width={size}
  height={size}
  viewBox="0 0 12 12"
  style="color: {color}; --glyph-morph: {PHASE_MS}ms"
  aria-hidden="true"
>
  {#each slots as s (s.key)}
    <!-- Geometry as inline CSS, not attributes: WebKit only transitions the
         CSS properties; attribute changes snap. -->
    <rect
      style="x: {s.x}px; y: {s.y}px; width: {s.w}px; height: {s.h}px; rx: {s.rx}px; scale: {s.sc}; --glyph-delay: {s.delay}ms"
      fill={s.fill}
    />
  {/each}
</svg>

<style>
  .ident-glyph {
    flex-shrink: 0;
    display: block;
  }
  /* Linear geometry tween — duration rides the inline --glyph-morph var
     (matches PHASE_MS); each rect's start time rides its own --glyph-delay
     (the choreography's per-slot schedule). No literals here. */
  .ident-glyph rect {
    transition-property: x, y, width, height, rx, scale, fill;
    transition-duration: var(--glyph-morph);
    transition-delay: var(--glyph-delay);
    transition-timing-function: linear;
    /* `scale` works about each shape's own center — dot pop in/out. */
    transform-box: fill-box;
    transform-origin: center;
  }
</style>
