<script lang="ts">
  // Workspace identity mark: the seeded 3×3 blob glyph (identityGlyph.ts) as
  // an SVG, tinted by `color`. Prop-driven primitive (no stores/api). This is
  // a GENERATIVE mark, not an icon — no Lucide equivalent exists, hence the
  // deliberate hand-drawn SVG (the icons-are-Lucide-only rule targets icons).
  import { glyphShapes } from "../identityGlyph";

  let {
    seed,
    color,
    size = 12,
  }: {
    seed: string;
    /** The identity accent; shapes fill it via currentColor. */
    color: string;
    /** Rendered square size in px. */
    size?: number;
  } = $props();

  const CELL = 4; // viewBox units per grid cell
  // Optical compensation: circles at the same bounding height as bars READ
  // smaller (less edge area), so single dots overshoot with a tighter inset.
  const INSET = 0.7; // pills
  const INSET_DOT = 0.45; // single dots — slightly larger than geometric parity
  const shapes = $derived(glyphShapes(seed));
</script>

<svg
  class="ident-glyph"
  width={size}
  height={size}
  viewBox="0 0 12 12"
  style="color: {color}"
  aria-hidden="true"
>
  {#each shapes as s (`${s.row},${s.col}`)}
    {@const inset = s.w === 1 && s.h === 1 ? INSET_DOT : INSET}
    {@const w = s.w * CELL - inset * 2}
    {@const h = s.h * CELL - inset * 2}
    <rect
      x={s.col * CELL + inset}
      y={s.row * CELL + inset}
      width={w}
      height={h}
      rx={Math.min(w, h) / 2}
      fill="currentColor"
    />
  {/each}
</svg>

<style>
  .ident-glyph {
    flex-shrink: 0;
    display: block;
  }
</style>
