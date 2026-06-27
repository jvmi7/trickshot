// A single background element that slides to the currently-highlighted item,
// instead of each item fading its own background in/out. Apply to the element
// wrapping the items; it watches `data-highlighted` (bits-ui sets that on the
// active item for BOTH mouse hover and keyboard nav) and animates a pooled
// highlight div to match its position + height.
export function slidingHighlight(wrap: HTMLElement) {
  wrap.style.position = "relative";

  const hl = document.createElement("div");
  Object.assign(hl.style, {
    position: "absolute",
    left: "4px",
    right: "4px",
    top: "0px",
    height: "0px",
    borderRadius: "6px",
    background: "var(--accent)",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "0",
    transform: "translateY(0px)",
    transition:
      "transform 170ms cubic-bezier(.22,.7,.25,1), height 170ms cubic-bezier(.22,.7,.25,1), opacity 130ms ease",
  });
  wrap.prepend(hl);

  let raf = 0;
  const update = () => {
    raf = 0;
    const item = wrap.querySelector(
      '[data-slot="select-item"][data-highlighted]',
    ) as HTMLElement | null;
    if (!item) {
      hl.style.opacity = "0";
      return;
    }
    hl.style.transform = `translateY(${item.offsetTop}px)`;
    hl.style.height = `${item.offsetHeight}px`;
    hl.style.opacity = "1";
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  // bits-ui toggles data-highlighted as the active item changes (hover + keyboard).
  const mo = new MutationObserver(schedule);
  mo.observe(wrap, { attributes: true, subtree: true, attributeFilter: ["data-highlighted"] });
  schedule();

  return {
    destroy() {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      hl.remove();
    },
  };
}

// Horizontal variant for a segmented toggle group: a single background that
// slides to the SELECTED item (the one carrying `data-active`), animating its
// x-position + width. Apply to the element wrapping the items; the items should
// be transparent (the sliding bg is the only fill) and stack above it (z-index).
export function slidingToggle(wrap: HTMLElement) {
  wrap.style.position = "relative";

  const hl = document.createElement("div");
  Object.assign(hl.style, {
    position: "absolute",
    top: "0",
    left: "0",
    height: "100%",
    borderRadius: "calc(var(--radius) - 6px)",
    background: "var(--secondary)",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "0",
    transition:
      "transform 180ms cubic-bezier(.22,.7,.25,1), width 180ms cubic-bezier(.22,.7,.25,1), opacity 130ms ease",
  });
  wrap.prepend(hl);

  let raf = 0;
  const update = () => {
    raf = 0;
    const item = wrap.querySelector("[data-active]") as HTMLElement | null;
    if (!item) {
      hl.style.opacity = "0";
      return;
    }
    hl.style.transform = `translateX(${item.offsetLeft}px)`;
    hl.style.width = `${item.offsetWidth}px`;
    hl.style.opacity = "1";
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  // data-active moves between items on selection; ResizeObserver catches layout
  // shifts (an item appearing/disappearing or its width changing).
  const mo = new MutationObserver(schedule);
  mo.observe(wrap, { attributes: true, subtree: true, attributeFilter: ["data-active"] });
  const ro = new ResizeObserver(schedule);
  ro.observe(wrap);
  schedule();

  return {
    destroy() {
      mo.disconnect();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      hl.remove();
    },
  };
}
