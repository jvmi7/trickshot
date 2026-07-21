// Cursor-proximity border highlight (the "spotlight border"): tracks the
// pointer WINDOW-wide and writes its position (relative to the node) into
// CSS vars, which app.css uses to paint a radial highlight masked to the
// node's 1px border ring — the border lightens near the cursor and fades
// with distance. Svelte `use:` action, the customScroll/slidingHighlight
// sibling. rAF-coalesced (PERFORMANCE): at most one style write per frame,
// and the effect layer is pointer-events: none, so nothing else changes.

export function borderGlow(node: HTMLElement): { destroy(): void } {
  let raf = 0;
  let x = 0;
  let y = 0;
  let visible = false;

  let last = "";
  const paint = () => {
    raf = 0;
    const r = node.getBoundingClientRect();
    // Skip identical writes: paint is ALSO triggered by the node's own style
    // mutations (see the observer below), and unguarded setProperty calls
    // would re-fire it forever.
    const next = `${(x - r.left).toFixed(1)},${(y - r.top).toFixed(1)},${visible ? 1 : 0}`;
    if (next === last) return;
    last = next;
    node.style.setProperty("--glow-x", `${x - r.left}px`);
    // Right-anchored twin (negative left of the right edge): consumers whose
    // boxes hang off the node's RIGHT side (the chat tab's right flare glow)
    // can center the light without knowing the node's width.
    node.style.setProperty("--glow-xr", `${x - r.right}px`);
    node.style.setProperty("--glow-y", `${y - r.top}px`);
    node.style.setProperty("--glow-o", visible ? "1" : "0");
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(paint);
  };
  // Repaint when the NODE moves under a stationary cursor (the sliding tab
  // chrome springs its position every frame): its style mutations re-derive
  // the vars from the fresh rect — no pointer movement required.
  const mo = new MutationObserver(schedule);
  mo.observe(node, { attributes: true, attributeFilter: ["style"] });
  const onMove = (e: PointerEvent) => {
    x = e.clientX;
    y = e.clientY;
    visible = true;
    schedule();
  };
  // Pointer left the window entirely — fade the glow out (CSS transitions it).
  const onOut = (e: PointerEvent) => {
    if (!e.relatedTarget) {
      visible = false;
      schedule();
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerout", onOut);
  return {
    destroy() {
      mo.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerout", onOut);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
