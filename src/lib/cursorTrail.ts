// Trailing cursor effect for the terminal backdrop: a GRID OF SQUARES that
// light up in a neutral gray as a lerped point CHASES the pointer (the
// trail feel), painted on a canvas in the layer BEHIND the transparent xterm
// so glyphs float above it. Each cell chases its own intensity — rising fast
// under the point, decaying slowly behind it — and brightness is quantized
// into discrete steps, so the wake reads as pixels switching levels, not a
// smooth glow. Svelte `use:` action — the borderGlow/customScroll sibling.
// PERFORMANCE: the rAF loop parks itself when the chase has settled AND every
// cell has faded to dark; a frame is one pass over a Float32Array + one
// fillRect per LIT cell (no DOM writes, no per-frame allocation).

const EASE = 0.1; // fraction of the remaining distance covered per frame
const SETTLE = 0.5; // px/opacity epsilon below which the chase is settled
const CELL = 12; // grid pitch (px); squares are flush — a lit cell fills its whole cell
const RADIUS = 170; // influence radius around the chased point (px)
const RISE = 0.3; // per-frame pull toward a HIGHER target — light up fast
const DECAY = 0.05; // per-frame pull toward a LOWER target — linger (the wake)
const MAX_ALPHA = 0.04; // alpha of a fully lit square (keep it subtle)
const LEVELS = 5; // quantized brightness steps — the digital ramp
const EPS = 0.004; // intensity below which a cell counts as dark

/** `reach: true` keeps the trail lit while the pointer is within the trail
 *  RADIUS outside the node — so canvases that share one visual surface (the
 *  terminal backdrop and the active chat tab) stay lit together while the
 *  cursor crosses their seam instead of one fading at the boundary. */
export function cursorTrail(
  node: HTMLElement,
  opts: { reach?: boolean } = {},
): { destroy(): void } {
  const pad = opts.reach ? RADIUS : 0;
  const canvas = document.createElement("canvas");
  node.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let raf = 0;
  // target (pointer) vs current (the trailing point)
  let tx = 0;
  let ty = 0;
  let x = 0;
  let y = 0;
  let to = 0; // target opacity (pointer inside the pane?)
  let o = 0;

  let w = 0;
  let h = 0;
  let cols = 0;
  let rows = 0;
  // Grid phase: cell boundaries anchor to the VIEWPORT, not the node, so two
  // trail canvases on one visual surface (terminal backdrop + active tab)
  // share the same grid — squares line up across their seam.
  let phaseX = 0;
  let phaseY = 0;
  let cells = new Float32Array(0); // per-cell intensity, row-major
  let color = "";

  const resize = () => {
    const r = node.getBoundingClientRect();
    w = r.width;
    h = r.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    phaseX = ((r.left % CELL) + CELL) % CELL;
    phaseY = ((r.top % CELL) + CELL) % CELL;
    cols = Math.ceil((w + phaseX) / CELL);
    rows = Math.ceil((h + phaseY) / CELL);
    cells = new Float32Array(cols * rows); // reset on resize — rare + cheap
    kick();
  };

  const tick = () => {
    raf = 0;
    if (!ctx) return;
    x += (tx - x) * EASE;
    y += (ty - y) * EASE;
    o += (to - o) * EASE;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;
    const r2 = RADIUS * RADIUS;
    let lit = false;
    for (let cy = 0; cy < rows; cy++) {
      const dy = cy * CELL - phaseY + CELL / 2 - y;
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        const v = cells[i] ?? 0;
        const dx = cx * CELL - phaseX + CELL / 2 - x;
        const d2 = dx * dx + dy * dy;
        if (v === 0 && d2 >= r2) continue; // dark + out of range: no work
        // Quadratic falloff (squared distance — no sqrt on the hot path).
        const t = d2 < r2 ? (1 - d2 / r2) * o : 0;
        const next = v + (t - v) * (t > v ? RISE : DECAY);
        if (next < EPS) {
          cells[i] = 0;
          continue;
        }
        cells[i] = next;
        lit = true;
        // Quantize the ramp into discrete levels — the digital feel.
        ctx.globalAlpha = (Math.ceil(next * LEVELS) / LEVELS) * MAX_ALPHA;
        ctx.fillRect(cx * CELL - phaseX, cy * CELL - phaseY, CELL, CELL);
      }
    }
    ctx.globalAlpha = 1;

    const moving =
      Math.abs(tx - x) > SETTLE || Math.abs(ty - y) > SETTLE || Math.abs(to - o) > 0.01;
    if (moving || lit) raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (raf) return;
    // NEUTRAL on purpose (the theme's plain foreground gray, not the workspace
    // accent) — the backdrop shouldn't compete with the identity-colored chrome.
    // Re-resolved only on wake from parked (cheap, and catches theme switches
    // without a per-frame getComputedStyle).
    color = getComputedStyle(node).getPropertyValue("--base-text").trim();
    raf = requestAnimationFrame(tick);
  };

  const onMove = (e: PointerEvent) => {
    const r = node.getBoundingClientRect();
    const inside =
      e.clientX >= r.left - pad &&
      e.clientX <= r.right + pad &&
      e.clientY >= r.top - pad &&
      e.clientY <= r.bottom + pad;
    tx = e.clientX - r.left;
    ty = e.clientY - r.top;
    to = inside ? 1 : 0;
    kick();
  };
  const onOut = (e: PointerEvent) => {
    if (!e.relatedTarget) {
      to = 0;
      kick();
    }
  };

  const ro = new ResizeObserver(resize);
  ro.observe(node);
  resize();

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerout", onOut);
  return {
    destroy() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerout", onOut);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
}
