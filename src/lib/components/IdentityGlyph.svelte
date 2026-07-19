<script lang="ts">
  // Workspace identity mark: the seeded 3×3 blob glyph (identityGlyph.ts) as
  // an SVG, tinted by `color`. Prop-driven primitive (no stores/api). This is
  // a GENERATIVE mark, not an icon — no Lucide equivalent exists, hence the
  // deliberate hand-drawn SVG (the icons-are-Lucide-only rule targets icons).
  //
  // `loading` morphs the mark through RANDOM glyphs every 500ms with linear
  // tweens: the svg renders a FIXED set of 9 slots (unused ones collapse to a
  // zero-size center rect) so successive glyphs animate geometry instead of
  // swapping nodes — SVG rect x/y/width/height/rx are CSS-transitionable.
  import { glyphShapes } from "../identityGlyph";

  let {
    seed,
    color,
    size = 12,
    loading = false,
  }: {
    seed: string;
    /** The identity accent; shapes fill it via currentColor. */
    color: string;
    /** Rendered square size in px. */
    size?: number;
    /** Morph through random glyphs (the busy indicator). */
    loading?: boolean;
  } = $props();

  const CELL = 4; // viewBox units per grid cell
  // Optical compensation: circles at the same bounding height as bars READ
  // smaller (less edge area), so single dots overshoot with a tighter inset.
  const INSET = 0.7; // pills
  const INSET_DOT = 0.45; // single dots — slightly larger than geometric parity
  const MORPH_MS = 500;

  // While loading, advance the seed every MORPH_MS — each tick is a fresh
  // random-looking glyph; the CSS transition (same duration, linear) tweens
  // continuously between them. tick resets when loading ends, restoring the
  // workspace's own stable mark.
  let tick = $state(0);
  $effect(() => {
    if (!loading) {
      tick = 0;
      return;
    }
    const t = setInterval(() => {
      tick += 1;
    }, MORPH_MS);
    return () => clearInterval(t);
  });

  interface Slot {
    x: number;
    y: number;
    w: number;
    h: number;
    rx: number;
    o: number;
  }
  const slots = $derived.by((): Slot[] => {
    const shapes = glyphShapes(loading ? `${seed}#${tick}` : seed);
    const out: Slot[] = [];
    for (let i = 0; i < 9; i++) {
      const s = shapes[i];
      if (s) {
        const inset = s.w === 1 && s.h === 1 ? INSET_DOT : INSET;
        const w = s.w * CELL - inset * 2;
        const h = s.h * CELL - inset * 2;
        out.push({ x: s.col * CELL + inset, y: s.row * CELL + inset, w, h, rx: Math.min(w, h) / 2, o: 1 });
      } else {
        // Unused slot: collapse into the center, invisible — appears/vanishes
        // by growing/shrinking through the same tween.
        out.push({ x: 6, y: 6, w: 0, h: 0, rx: 0, o: 0 });
      }
    }
    return out;
  });
</script>

<svg
  class="ident-glyph"
  width={size}
  height={size}
  viewBox="0 0 12 12"
  style="color: {color}; --glyph-morph: {MORPH_MS}ms"
  aria-hidden="true"
>
  {#each slots as s, i (i)}
    <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.rx} opacity={s.o} fill="currentColor" />
  {/each}
</svg>

<style>
  .ident-glyph {
    flex-shrink: 0;
    display: block;
  }
  /* Linear geometry tween between glyphs — duration rides the inline
     --glyph-morph var (matches the tick interval; no literal here). */
  .ident-glyph rect {
    transition-property: x, y, width, height, rx, opacity;
    transition-duration: var(--glyph-morph);
    transition-timing-function: linear;
  }
</style>
