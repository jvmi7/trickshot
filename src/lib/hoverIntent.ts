// Hover-intent scheduling for hover-revealed popovers (the header Changes /
// Shell popovers): open after a short dwell so a pointer merely crossing the
// trigger doesn't flash the panel, close after a grace period so the pointer
// can cross the gap between trigger and panel without losing it. Pure timer
// choreography — the CALLER owns the open state and any pin semantics (a
// pinned popover simply ignores the close callback). The scheduler is
// injectable for tests; production uses real timers.

export interface HoverIntentScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface HoverIntent {
  /** Pointer entered the trigger: cancel a pending close, schedule the open. */
  enter(): void;
  /** Pointer left the trigger or the panel: cancel a pending open, schedule the close. */
  leave(): void;
  /** Pointer entered the panel: the scheduled close is off. */
  cancelClose(): void;
  /** Clear every pending timer (click took over, or teardown). */
  cancel(): void;
}

/** Open after a short dwell — long enough to skip accidental crossings, short
 *  enough to read as "reveal". */
const OPEN_DELAY_MS = 150;
/** Close grace — long enough to travel trigger → panel across the side offset. */
const CLOSE_GRACE_MS = 300;

const realTimers: HoverIntentScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createHoverIntent(opts: {
  setOpen: (open: boolean) => void;
  openDelay?: number;
  closeGrace?: number;
  scheduler?: HoverIntentScheduler;
}): HoverIntent {
  const { setOpen, openDelay = OPEN_DELAY_MS, closeGrace = CLOSE_GRACE_MS } = opts;
  const timers = opts.scheduler ?? realTimers;
  let openT: unknown = null;
  let closeT: unknown = null;

  function clearOpen() {
    if (openT != null) {
      timers.clear(openT);
      openT = null;
    }
  }
  function clearClose() {
    if (closeT != null) {
      timers.clear(closeT);
      closeT = null;
    }
  }

  return {
    enter() {
      clearClose();
      if (openT == null) {
        openT = timers.set(() => {
          openT = null;
          setOpen(true);
        }, openDelay);
      }
    },
    leave() {
      clearOpen();
      clearClose();
      closeT = timers.set(() => {
        closeT = null;
        setOpen(false);
      }, closeGrace);
    },
    cancelClose() {
      clearClose();
    },
    cancel() {
      clearOpen();
      clearClose();
    },
  };
}
