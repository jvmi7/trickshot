// Custom transform-based "scroll" for the chat pane: it never natively scrolls.
// Wheel input drives a global cursor (`scrollCursor`); we ease toward it with a
// velocity-aware curve and translate the content. Sticks to the bottom on new
// content, and drives the ScrollIndicator. (The edge fades are pure CSS.)

import { scrollCursor } from "./stores";

// ---- tuning knobs ----
const SMOOTH = 0.16; //       ease toward target per frame (↑ = snappier)
const WHEEL_SCALE = 1; //     cursor px per wheel-delta px
const SETTLE_VEL = 0.3; //    ≤ this speed (at target) ⇒ settle
const SETTLE_DIST = 0.6; //   px-to-target considered "arrived"

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Nearest ancestor of `start` (up to but excluding `stop`) that can scroll
 *  horizontally — e.g. a wide code block. Lets a horizontal wheel gesture scroll
 *  it natively instead of being swallowed by the pane's custom vertical scroll. */
function hScrollable(start: Element | null, stop: HTMLElement): HTMLElement | null {
  let el = start as HTMLElement | null;
  while (el && el !== stop) {
    if (el.scrollWidth > el.clientWidth) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return el;
    }
    el = el.parentElement;
  }
  return null;
}

/** Svelte action: apply to the viewport; its `[data-scroll-inner]` child is transformed. */
export function customScroll(node: HTMLElement) {
  const inner =
    (node.querySelector("[data-scroll-inner]") as HTMLElement | null) ??
    (node.firstElementChild as HTMLElement | null);
  if (!inner) return {};

  let viewportH = node.clientHeight;
  let max = Math.max(0, inner.scrollHeight - viewportH);
  let target = max; // start pinned to the bottom (latest message)
  let current = max;
  let prev = max;
  let userScrolling = false;
  let raf = 0;

  const apply = () => {
    inner.style.transform = `translate3d(0, ${-current}px, 0)`;
  };
  const publish = () =>
    scrollCursor.set({ progress: max > 0 ? current / max : 0, active: userScrolling, max });

  // Content/viewport size changes: stay pinned to bottom if we were there
  // (streaming, new turns), else hold position.
  const measure = () => {
    viewportH = node.clientHeight;
    const atBottom = target >= max - 2;
    max = Math.max(0, inner.scrollHeight - viewportH);
    if (atBottom) {
      target = current = prev = max;
    } else {
      target = clamp(target, 0, max);
      current = clamp(current, 0, max);
    }
    apply();
    publish();
  };

  const frame = () => {
    raf = 0;
    current += (target - current) * SMOOTH;
    if (Math.abs(target - current) < SETTLE_DIST) current = target;
    const speed = Math.abs(current - prev);
    prev = current;
    apply();
    publish();

    if (userScrolling && speed < SETTLE_VEL && Math.abs(target - current) < SETTLE_DIST) {
      userScrolling = false;
    }
    if (Math.abs(target - current) > SETTLE_DIST || userScrolling) {
      raf = requestAnimationFrame(frame);
    } else {
      publish();
    }
  };

  const ensure = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const onWheel = (e: WheelEvent) => {
    // A horizontal gesture (trackpad swipe / shift-wheel) over a horizontally-
    // scrollable child (e.g. a wide code block) scrolls THAT natively — the pane
    // only ever scrolls vertically. Defer only while the child can still move that
    // way, so reaching its edge doesn't trap the gesture.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const el = hScrollable(e.target as Element | null, node);
      if (el) {
        const atStart = e.deltaX < 0 && el.scrollLeft <= 0;
        const atEnd = e.deltaX > 0 && el.scrollLeft >= el.scrollWidth - el.clientWidth - 1;
        if (!atStart && !atEnd) return; // let the browser scroll the child natively
      }
      e.preventDefault(); // nowhere horizontal to go; the pane has no x-scroll
      return;
    }
    e.preventDefault(); // vertical: the pane never natively scrolls
    if (max <= 0) return;
    target = clamp(target + e.deltaY * WHEEL_SCALE, 0, max);
    userScrolling = true;
    ensure();
  };

  node.addEventListener("wheel", onWheel, { passive: false });
  const ro = new ResizeObserver(() => measure());
  ro.observe(node);
  ro.observe(inner);
  measure();

  return {
    destroy() {
      node.removeEventListener("wheel", onWheel);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
