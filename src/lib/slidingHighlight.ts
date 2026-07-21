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

// Vertical variant for the sidebar's worktree rows: TWO pooled layers under
// the rows — a persistent one following the `.active` row and a transient one
// following the pointer-hovered row (two, because the active row must stay
// filled while another row is hovered). Rows must be position:relative so
// their content paints above the layers (see .wt-row in app.css). Unlike the
// siblings this watches childList too: rows mount/unmount (collapsing a repo
// group, create/archive), which shifts every row below and can remove the
// tracked node. Positioning uses rect deltas + scrollTop so it's correct both
// when the wrap scrolls itself (the archived list) and when an ancestor
// scrolls wrap + rows together (.sidebar-list).
export function slidingRowHighlight(wrap: HTMLElement, opts: { rowSelector?: string } = {}) {
  const rowSelector = opts.rowSelector ?? ".wt-row";
  wrap.style.position = "relative";

  // Opacity fades ride the app feedback clock; the slide keeps the siblings' feel.
  const fade =
    getComputedStyle(document.documentElement).getPropertyValue("--app-duration-fast").trim() ||
    "120ms";
  // Group-aware corner radius: the layer reads as one segmented block, so only
  // the group's outer edges are rounded (first row = top corners, last = bottom,
  // middle = none, a lone row = all four). Animated with the slide. The rows'
  // own radius (their :active press tint) mirrors this via first/last-of-type
  // rules in app.css — which is why the layers are SPANS: a div layer would
  // steal the rows' :first-of-type.
  const RADIUS = "var(--radius-xl)";
  const SLIDE = "170ms cubic-bezier(.22,.7,.25,1)";
  const makeLayer = (background: string) => {
    const el = document.createElement("span");
    Object.assign(el.style, {
      position: "absolute",
      left: "0",
      right: "0",
      top: "0px",
      height: "0px",
      borderRadius: RADIUS,
      background,
      opacity: "0",
      pointerEvents: "none",
      zIndex: "0",
      transform: "translateY(0px)",
      transition: `transform ${SLIDE}, height ${SLIDE}, border-radius ${SLIDE}, opacity ${fade} ease`,
    });
    wrap.prepend(el);
    return el;
  };
  const activeLayer = makeLayer("var(--app-panel-2)");
  const hoverLayer = makeLayer("var(--app-panel)");

  let hovered: HTMLElement | null = null;
  // Whether the pointer is anywhere over the wrap: while it is, the rows read
  // as one segmented block (group-aware corners); once it leaves, the active
  // layer stands alone and rounds evenly on all four corners.
  let wrapHovered = false;

  const place = (layer: HTMLElement, row: HTMLElement | null, evenCorners: boolean) => {
    if (!row?.isConnected) {
      layer.style.opacity = "0";
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (evenCorners) {
      layer.style.borderRadius = RADIUS;
    } else {
      const rows = wrap.querySelectorAll<HTMLElement>(rowSelector);
      const top = rows[0] === row ? RADIUS : "0px";
      const bottom = rows[rows.length - 1] === row ? RADIUS : "0px";
      layer.style.borderRadius = `${top} ${top} ${bottom} ${bottom}`;
    }
    layer.style.transform = `translateY(${rect.top - wrapRect.top + wrap.scrollTop}px)`;
    layer.style.height = `${rect.height}px`;
    layer.style.opacity = "1";
  };

  let raf = 0;
  const update = () => {
    raf = 0;
    if (hovered && !hovered.isConnected) hovered = null;
    place(activeLayer, wrap.querySelector<HTMLElement>(`${rowSelector}.active`), !wrapHovered);
    place(hoverLayer, hovered, false);
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  // :hover isn't attribute-observable, so hover is tracked by delegation;
  // `closest` keeps the highlight on the row while hovering its nested buttons.
  const onPointerOver = (e: PointerEvent) => {
    const row = (e.target as Element | null)?.closest<HTMLElement>(rowSelector);
    hovered = row && wrap.contains(row) ? row : null;
    wrapHovered = true;
    schedule();
  };
  const onPointerLeave = () => {
    hovered = null;
    wrapHovered = false;
    schedule();
  };
  wrap.addEventListener("pointerover", onPointerOver);
  wrap.addEventListener("pointerleave", onPointerLeave);

  // `.active` moves between rows (class) and rows mount/unmount (childList) —
  // both shift the geometry the layers track.
  const mo = new MutationObserver(schedule);
  mo.observe(wrap, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  const ro = new ResizeObserver(schedule);
  ro.observe(wrap);
  schedule();

  return {
    destroy() {
      mo.disconnect();
      ro.disconnect();
      wrap.removeEventListener("pointerover", onPointerOver);
      wrap.removeEventListener("pointerleave", onPointerLeave);
      if (raf) cancelAnimationFrame(raf);
      activeLayer.remove();
      hoverLayer.remove();
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

// The chat-tab chrome slider: ONE overlay carrying the active tab's frame /
// flares / glow layers (ChatTabs › .chat-tab-chrome), positioned over
// `[data-active]` and CSS-transitioned so switching tabs GLIDES the chrome
// left/right instead of teleporting it. The silhouette bump and the glow-ring
// notch animate in step via their own clip-path transitions (app.css).
// data-flush mirrors the first-tab merge state for the flush-specific rules.
export function slidingTabChrome(el: HTMLElement) {
  const strip = el.parentElement;
  if (!strip) return { destroy() {} };
  let raf = 0;
  let first = true;
  const update = () => {
    raf = 0;
    const tab = strip.querySelector<HTMLElement>(".chat-tab[data-active]");
    if (!tab) {
      el.style.opacity = "0";
      return;
    }
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    // First placement lands without animating (no slide-in from nowhere).
    if (first) el.style.transition = "none";
    el.style.opacity = "1";
    el.style.left = `${t.left - s.left}px`;
    el.style.top = `${t.top - s.top}px`;
    el.style.width = `${t.width}px`;
    // +1: the chrome dips one row into the card, swallowing its top border
    // (the overlap the active button itself used to provide).
    el.style.height = `${t.height + 1}px`;
    if (strip.querySelector(".chat-tab") === tab) el.setAttribute("data-flush", "");
    else el.removeAttribute("data-flush");
    if (first) {
      void el.offsetWidth; // flush styles before re-enabling the transition
      el.style.transition = "";
      first = false;
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  // data-active moves on switch; style catches snapWidth's width pinning;
  // childList catches tabs being added/closed.
  const mo = new MutationObserver(schedule);
  mo.observe(strip, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-active", "style"],
  });
  const ro = new ResizeObserver(schedule);
  ro.observe(strip);
  schedule();
  return {
    destroy() {
      mo.disconnect();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
