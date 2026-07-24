import { describe, expect, test } from "bun:test";
import { createHoverIntent, type HoverIntentScheduler } from "./hoverIntent";

/** Deterministic scheduler: tasks fire only when the test advances time. */
function manualScheduler() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const scheduler: HoverIntentScheduler = {
    set(fn, ms) {
      const id = nextId++;
      tasks.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      tasks.delete(handle as number);
    },
  };
  function advance(ms: number) {
    now += ms;
    for (const [id, t] of [...tasks].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        tasks.delete(id);
        t.fn();
      }
    }
  }
  return { scheduler, advance, pending: () => tasks.size };
}

function setup(opts: { openDelay?: number; closeGrace?: number } = {}) {
  const { scheduler, advance, pending } = manualScheduler();
  const calls: boolean[] = [];
  const hover = createHoverIntent({
    setOpen: (v) => calls.push(v),
    openDelay: opts.openDelay ?? 150,
    closeGrace: opts.closeGrace ?? 300,
    scheduler,
  });
  return { hover, advance, pending, calls };
}

describe("createHoverIntent", () => {
  test("enter opens after the dwell delay", () => {
    const { hover, advance, calls } = setup();
    hover.enter();
    expect(calls).toEqual([]);
    advance(149);
    expect(calls).toEqual([]);
    advance(1);
    expect(calls).toEqual([true]);
  });

  test("a crossing pointer (enter then leave before the delay) never opens", () => {
    const { hover, advance, calls } = setup();
    hover.enter();
    advance(100);
    hover.leave();
    advance(1000);
    // The leave's scheduled close may fire, but no OPEN ever does.
    expect(calls).not.toContain(true);
  });

  test("leave closes after the grace period", () => {
    const { hover, advance, calls } = setup();
    hover.enter();
    advance(150);
    hover.leave();
    advance(299);
    expect(calls).toEqual([true]);
    advance(1);
    expect(calls).toEqual([true, false]);
  });

  test("entering the panel cancels the scheduled close (trigger → panel travel)", () => {
    const { hover, advance, calls } = setup();
    hover.enter();
    advance(150);
    hover.leave();
    advance(100);
    hover.cancelClose();
    advance(1000);
    expect(calls).toEqual([true]);
  });

  test("re-entering the trigger during the grace also cancels the close", () => {
    const { hover, advance, calls } = setup();
    hover.enter();
    advance(150);
    hover.leave();
    advance(100);
    hover.enter();
    advance(1000);
    // Re-entry cancels the close and (already open) schedules a redundant
    // open — the store's setter is idempotent, so a second `true` is fine;
    // what must NOT appear is a `false`.
    expect(calls).not.toContain(false);
  });

  test("enter is not re-armed while an open is already pending", () => {
    const { hover, advance, calls } = setup();
    hover.enter();
    advance(100);
    hover.enter(); // jitter re-entry must not reset the dwell clock
    advance(50);
    expect(calls).toEqual([true]);
  });

  test("cancel clears everything pending", () => {
    const { hover, advance, calls, pending } = setup();
    hover.enter();
    hover.cancel();
    advance(1000);
    hover.enter();
    advance(150);
    hover.leave();
    hover.cancel();
    advance(1000);
    expect(calls).toEqual([true]);
    expect(pending()).toBe(0);
  });
});
