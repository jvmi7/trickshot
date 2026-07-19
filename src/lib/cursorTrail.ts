// Trailing cursor glow for the terminal backdrop: a radial light that CHASES
// the pointer with a lerp (the trail feel), painted on the layer BEHIND the
// transparent xterm so glyphs float above it. Svelte `use:` action — the
// borderGlow/customScroll sibling. The rAF loop runs only while the glow is
// moving or fading (PERFORMANCE: it parks itself when settled), and writes
// three CSS vars per frame at most.

const EASE = 0.1; // fraction of the remaining distance covered per frame
const SETTLE = 0.5; // px/opacity epsilon below which the loop parks

export function cursorTrail(node: HTMLElement): { destroy(): void } {
  let raf = 0;
  // target (pointer) vs current (the trailing glow)
  let tx = 0;
  let ty = 0;
  let x = 0;
  let y = 0;
  let to = 0; // target opacity (pointer inside the pane?)
  let o = 0;

  const tick = () => {
    raf = 0;
    x += (tx - x) * EASE;
    y += (ty - y) * EASE;
    o += (to - o) * EASE;
    node.style.setProperty("--trail-x", `${x}px`);
    node.style.setProperty("--trail-y", `${y}px`);
    node.style.setProperty("--trail-o", o.toFixed(3));
    const moving =
      Math.abs(tx - x) > SETTLE || Math.abs(ty - y) > SETTLE || Math.abs(to - o) > 0.01;
    if (moving) raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };

  const onMove = (e: PointerEvent) => {
    const r = node.getBoundingClientRect();
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
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

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerout", onOut);
  return {
    destroy() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerout", onOut);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
