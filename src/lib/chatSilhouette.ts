// Clips the shared chat-trail surface (App.svelte › .chat-trail — ONE canvas
// behind the whole chat surface) to the SILHOUETTE of card ∪ active tab: the
// content card's inner rounded rect, plus the active tab's rounded-top bump
// rising through the strip band. The tab/panes above are transparent, so the
// one surface shows through everywhere — a background with the chrome as a
// mask, which is what makes the cursor trail seamless by construction (no
// per-element canvases to stitch). The tiny concave flare feet are excluded;
// the flares' own opaque fill covers them. Svelte `use:` action — the
// borderGlow/cursorTrail sibling.
//
// Geometry is measured live (the tab moves and resizes; the card resizes) and
// rebuilt rAF-coalesced on host resize + strip mutations. clip-path: path()
// takes absolute px, hence JS, not static CSS.

/** Read a px-valued CSS var off :root (e.g. the radius tokens). */
function pxVar(name: string, fallback: number): number {
  const v = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

export function chatSilhouette(host: HTMLElement): { destroy(): void } {
  let raf = 0;

  const update = () => {
    raf = 0;
    const parent = host.parentElement; // .content — the card
    if (!parent) return;
    const hostR = host.getBoundingClientRect();
    const parentR = parent.getBoundingClientRect();
    const W = hostR.width;
    const H = hostR.height;
    if (W <= 0 || H <= 0) return;
    // The card's inner top edge (below its 1px border) in host coords.
    const y0 = parentR.top + 1 - hostR.top;
    const r = pxVar("--app-pane-radius-inner", 13); // card inner corners
    const t = pxVar("--app-tab-radius", 10); // tab top corners
    const f = pxVar("--radius-xl", 8); // flare (concave foot) radius

    const tab = document.querySelector<HTMLElement>(".chat-tab[data-active]");
    const b = H - r;
    let d: string;
    if (!tab) {
      // No tab (shouldn't happen while the chat surface shows) — card only.
      d = `M 0 ${y0 + r} A ${r} ${r} 0 0 1 ${r} ${y0} L ${W - r} ${y0} A ${r} ${r} 0 0 1 ${W} ${y0 + r} L ${W} ${b} A ${r} ${r} 0 0 1 ${W - r} ${H} L ${r} ${H} A ${r} ${r} 0 0 1 0 ${b} Z`;
      parent.style.removeProperty("--frame-clip");
    } else {
      const tr = tab.getBoundingClientRect();
      const xL = tr.left - hostR.left;
      const xR = tr.right - hostR.left;
      const yT = tr.top - hostR.top;
      // Flush first tab: its left edge merges with the card's — the bump's
      // left side IS the card's left edge, no top-left card corner.
      const flush = xL < 2;
      // The concave FEET are part of the silhouette (sweep 0 = the arc hugs
      // the corner): the one surface fills them, the flares paint stroke only.
      const rise = flush
        ? `M 0 ${yT + t} A ${t} ${t} 0 0 1 ${t} ${yT}`
        : `M 0 ${y0 + r} A ${r} ${r} 0 0 1 ${r} ${y0} L ${xL - f} ${y0} A ${f} ${f} 0 0 0 ${xL} ${y0 - f} L ${xL} ${yT + t} A ${t} ${t} 0 0 1 ${xL + t} ${yT}`;
      d = `${rise} L ${xR - t} ${yT} A ${t} ${t} 0 0 1 ${xR} ${yT + t} L ${xR} ${y0 - f} A ${f} ${f} 0 0 0 ${xR + f} ${y0} L ${W - r} ${y0} A ${r} ${r} 0 0 1 ${W} ${y0 + r} L ${W} ${b} A ${r} ${r} 0 0 1 ${W - r} ${H} L ${r} ${H} A ${r} ${r} 0 0 1 0 ${b} Z`;
    }
    host.style.clipPath = `path("${d}")`;
    if (tab) {
      // The cursor-glow ring (.content::after) paints ABOVE the card's
      // children — with the tab transparent, its top segment would shine
      // through the opening as an underline. Publish a clip that notches the
      // ring out across the tab's inner width (the flares' opaque fill covers
      // the feet). Coordinates are in the ::after's box (inset -1px of the
      // card, so shifted +1 from border-box).
      const tr = tab.getBoundingClientRect();
      // The opening now spans the feet too (silhouette includes them).
      const nL = tr.left - f + 1 - parentR.left;
      const nR = tr.right + f + 1 - parentR.left;
      const cW = parentR.width + 2;
      const cH = parentR.height + 2;
      parent.style.setProperty(
        "--frame-clip",
        `path("M 0 0 L ${nL} 0 L ${nL} 3 L ${nR} 3 L ${nR} 0 L ${cW} 0 L ${cW} ${cH} L 0 ${cH} Z")`,
      );
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  const ro = new ResizeObserver(schedule);
  ro.observe(host);
  // The bump follows the ACTIVE tab: switching tabs moves data-active
  // (attributes), adding/closing tabs shifts every box (childList).
  const strip = document.querySelector(".chat-tabs");
  const mo = new MutationObserver(schedule);
  if (strip) {
    mo.observe(strip, { subtree: true, attributes: true, childList: true });
    ro.observe(strip);
  }
  schedule();

  return {
    destroy() {
      ro.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
