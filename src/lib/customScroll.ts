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
    e.preventDefault(); // the pane never natively scrolls
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
