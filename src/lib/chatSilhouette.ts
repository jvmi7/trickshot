// Clips the shared chat-trail surface (App.svelte › .chat-trail — ONE canvas
// behind the whole chat surface) to the SILHOUETTE of the visible chrome:
// TABS layout = the content card's inner rounded rect ∪ the active tab's
// rounded-top bump rising through the strip band; GRID layout = the union of
// the floating cell rects (one rounded-rect subpath per cell). The tab/panes/
// cells above are transparent, so the one surface shows through everywhere —
// a background with the chrome as a mask, which is what makes the cursor
// trail seamless by construction (no per-element canvases to stitch). The
// tiny concave flare feet are excluded; the flares' own opaque fill covers
// them. Svelte `use:` action — the borderGlow/cursorTrail sibling.
//
// Geometry is measured live (the tab moves and resizes; the card and cells
// resize) and rebuilt rAF-coalesced on host resize + strip mutations + grid
// cell changes. clip-path: path() takes absolute px, hence JS, not static
// CSS.

/** Read a px-valued CSS var off :root (e.g. the radius tokens). */
function pxVar(name: string, fallback: number): number {
  const v = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

export function chatSilhouette(host: HTMLElement): { destroy(): void } {
  let raf = 0;
  // Last-written values: every style write is guarded so the SYNCHRONOUS
  // mutation-observer path below can't ping-pong on its own writes, and
  // unchanged frames cost nothing.
  let lastPath = "";
  let lastClip = "";
  let lastTl = "";
  let lastFl = "";

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

    // GRID layout: the silhouette is the union of the floating cells' inner
    // rounded rects — one subpath each (disjoint rects union under nonzero
    // fill). No bump, no notch, no corner morph: clear the tab-mode vars and
    // RESET their guards so tabs-mode re-entry rewrites them. Zero measurable
    // cells (a mid-swap frame) falls through to the card/tab branch below.
    const gridEl = parent.querySelector<HTMLElement>(".chat-grid");
    if (gridEl) {
      const subpaths: string[] = [];
      for (const cell of gridEl.querySelectorAll<HTMLElement>(".chat-grid-cell")) {
        const c = cell.getBoundingClientRect();
        if (c.width <= 2 || c.height <= 2) continue;
        // Inner edge of the cell's 1px border, in host coords.
        const x0 = c.left + 1 - hostR.left;
        const x1 = c.right - 1 - hostR.left;
        const y0c = c.top + 1 - hostR.top;
        const y1 = c.bottom - 1 - hostR.top;
        const cr = Math.min(r, (x1 - x0) / 2, (y1 - y0c) / 2);
        subpaths.push(
          `M ${x0} ${y0c + cr} A ${cr} ${cr} 0 0 1 ${x0 + cr} ${y0c} L ${x1 - cr} ${y0c} A ${cr} ${cr} 0 0 1 ${x1} ${y0c + cr} L ${x1} ${y1 - cr} A ${cr} ${cr} 0 0 1 ${x1 - cr} ${y1} L ${x0 + cr} ${y1} A ${cr} ${cr} 0 0 1 ${x0} ${y1 - cr} Z`,
        );
      }
      if (subpaths.length > 0) {
        const dg = subpaths.join(" ");
        if (dg !== lastPath) {
          lastPath = dg;
          host.style.clipPath = `path("${dg}")`;
        }
        parent.style.removeProperty("--frame-clip");
        parent.style.removeProperty("--card-tl");
        lastClip = "";
        lastTl = "";
        lastFl = "";
        return;
      }
    }

    // Anchor on the sliding CHROME when it's live: the spring writes its
    // style every frame, the strip MutationObserver fires, and the bump/notch
    // re-derive from the chrome's CURRENT rect — background and border move
    // as one object, physics included. (Falls back to the tab pre-mount.)
    const chromeEl = document.querySelector<HTMLElement>(".chat-tab-chrome");
    const tab =
      chromeEl && chromeEl.style.opacity !== "0" && chromeEl.style.width
        ? chromeEl
        : document.querySelector<HTMLElement>(".chat-tab[data-active]");
    const b = H - r;
    let d: string;
    if (!tab) {
      // No tab (shouldn't happen while the chat surface shows) — card only.
      d = `M 0 ${y0 + r} A ${r} ${r} 0 0 1 ${r} ${y0} L ${W - r} ${y0} A ${r} ${r} 0 0 1 ${W} ${y0 + r} L ${W} ${b} A ${r} ${r} 0 0 1 ${W - r} ${H} L ${r} ${H} A ${r} ${r} 0 0 1 0 ${b} Z`;
      parent.style.removeProperty("--frame-clip");
      parent.style.removeProperty("--card-tl");
    } else {
      const tr = tab.getBoundingClientRect();
      const xL = tr.left - hostR.left;
      const xR = tr.right - hostR.left;
      const yT = tr.top - hostR.top;
      // The concave FEET are part of the silhouette (sweep 0 = the arc hugs
      // the corner): the one surface fills them, the flares paint stroke only.
      // The bump's sides sit at the tab's border INNER edges (±1) and the feet
      // use the flares' exact circles (they anchor to the button's PADDING
      // box) — a border-box silhouette swallows the card border 1px wider
      // than the stroke covers, leaving a gap in the frame line at each foot.
      const xl = xL + 1;
      const xr = xR - 1;
      // CONTINUOUS flush: as the (sprung) chrome approaches the card's left
      // edge, the left foot arc (fl) and then the card's top-left corner (rl)
      // shrink as functions of the remaining space — the tab MORPHS into the
      // first-tab merge during the flight, no end-of-slide snap. The same
      // radii feed the CSS corner (--card-tl) and the chrome's left flare
      // (--flare-l) so canvas, border, and stroke morph in lockstep.
      const fl = Math.max(0, Math.min(f, xl));
      const rl = Math.max(0, Math.min(r, xl - fl));
      const corner = rl > 0.5 ? `M 0 ${y0 + rl} A ${rl} ${rl} 0 0 1 ${rl} ${y0}` : `M 0 ${y0}`;
      const foot =
        fl > 0.5 ? `L ${xl - fl} ${y0} A ${fl} ${fl} 0 0 0 ${xl} ${y0 - fl}` : `L ${xl} ${y0}`;
      const rise = `${corner} ${foot} L ${xl} ${yT + t} A ${t} ${t} 0 0 1 ${xl + t} ${yT}`;
      d = `${rise} L ${xr - t} ${yT} A ${t} ${t} 0 0 1 ${xr} ${yT + t} L ${xr} ${y0 - f} A ${f} ${f} 0 0 0 ${xr + f} ${y0} L ${W - r} ${y0} A ${r} ${r} 0 0 1 ${W} ${y0 + r} L ${W} ${b} A ${r} ${r} 0 0 1 ${W - r} ${H} L ${r} ${H} A ${r} ${r} 0 0 1 0 ${b} Z`;
      const tl = rl > 0.5 ? `${rl + 1}px` : "0px";
      if (tl !== lastTl) {
        lastTl = tl;
        parent.style.setProperty("--card-tl", tl);
      }
      const flv = `${fl}px`;
      if (tab === chromeEl && flv !== lastFl) {
        lastFl = flv;
        chromeEl.style.setProperty("--flare-l", flv);
      }
    }
    if (d !== lastPath) {
      lastPath = d;
      host.style.clipPath = `path("${d}")`;
    }
    if (tab) {
      // The cursor-glow ring (.content::after) paints ABOVE the card's
      // children — with the tab transparent, its top segment would shine
      // through the opening as an underline. Publish a clip that notches the
      // ring out across the tab's inner width (the flares' opaque fill covers
      // the feet). Coordinates are in the ::after's box (inset -1px of the
      // card, so shifted +1 from border-box).
      const tr = tab.getBoundingClientRect();
      // The opening spans the feet (same padding-box anchoring as the
      // flares). The ::after box aligns EXACTLY with the card's border box
      // (inset -1px against a padding box that hugs the border). The ring
      // OVERLAPS the arc landings by 1px rather than abutting: the tab sits
      // at fractional x, and two shapes meeting at a fractional boundary
      // each contribute partial coverage — a darker seam pixel. A doubled
      // pixel reads as connected; a partial one reads as a gap.
      const fl2 = Math.max(0, Math.min(f, tr.left - parentR.left));
      const nL = tr.left - fl2 + 2 - parentR.left;
      const nR = tr.right + f - 2 - parentR.left;
      const cW = parentR.width + 2;
      const cH = parentR.height + 2;
      // (box is border-box-sized +2 for the -1px inset on both axes)
      const clip = `path("M 0 0 L ${nL} 0 L ${nL} 3 L ${nR} 3 L ${nR} 0 L ${cW} 0 L ${cW} ${cH} L 0 ${cH} Z")`;
      if (clip !== lastClip) {
        lastClip = clip;
        parent.style.setProperty("--frame-clip", clip);
      }
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  const ro = new ResizeObserver(schedule);
  ro.observe(host);
  // The bump follows the ACTIVE tab: switching tabs moves data-active
  // (attributes), adding/closing tabs shifts every box (childList). The
  // rebuild runs SYNCHRONOUSLY in the observer callback (a microtask, still
  // within the same rendering frame): routing it through rAF would land one
  // frame behind the sprung chrome, and at peak spring velocity that reads
  // as the filled bump sliding beside the stroke. The write guards above
  // stop the observer re-firing on update()'s own style writes.
  const strip = document.querySelector(".chat-tabs");
  const mo = new MutationObserver(update);
  if (strip) {
    mo.observe(strip, { subtree: true, attributes: true, childList: true });
    ro.observe(strip);
  }

  // GRID discovery. PERFORMANCE: never subtree-observe .content — it holds
  // the xterm DOM, which mutates on every PTY chunk. The grid mounts as a
  // direct child of .content-clip, so a childList-only observer there catches
  // layout flips/pane swaps; a second childList-only observer on the grid
  // catches cell add/close; a ResizeObserver over the cells tracks the
  // geometry. All rAF-scheduled — nothing is sprung in grid mode.
  const gridRo = new ResizeObserver(schedule);
  const gridMo = new MutationObserver(() => {
    syncGridObservers();
    schedule();
  });
  const clipMo = new MutationObserver(() => {
    syncGridObservers();
    schedule();
  });
  let observedGrid: Element | null = null;
  function syncGridObservers() {
    const gridEl = host.parentElement?.querySelector(":scope > .content-clip > .chat-grid") ?? null;
    if (gridEl !== observedGrid) {
      gridMo.disconnect();
      observedGrid = gridEl;
      if (gridEl) gridMo.observe(gridEl, { childList: true });
    }
    gridRo.disconnect();
    if (gridEl) {
      for (const cell of gridEl.querySelectorAll(":scope > .chat-grid-cell")) {
        gridRo.observe(cell);
      }
    }
  }
  const clipEl = host.parentElement?.querySelector(":scope > .content-clip");
  if (clipEl) clipMo.observe(clipEl, { childList: true });
  syncGridObservers();
  schedule();

  return {
    destroy() {
      ro.disconnect();
      mo.disconnect();
      clipMo.disconnect();
      gridMo.disconnect();
      gridRo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
