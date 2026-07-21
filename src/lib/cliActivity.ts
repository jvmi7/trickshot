// Busy/idle detection for the Claude CLI PTY, derived from its output flow.
// The TUI repaints continuously while a turn runs (spinner + elapsed-time
// ticker) and is silent when idle (xterm blinks the cursor client-side), so
// "data is flowing" IS the busy signal — no protocol events exist on this
// path (the CLI emits no structured turn events). Pure state
// machine: the caller owns the timers and passes timestamps in, so the edge
// logic is unit-testable (terminal.ts wires it to the real stream).
//
// The busy EDGE needs evidence, not just a first byte: one-off output —
// keystroke echoes, scroll/focus repaints, a SIGWINCH redraw after a refit,
// the `--resume` boot replay — must not light the busy indicator. Three
// filters handle that: (1) a burst must be SUSTAINED (min events + duration)
// before busy is announced; (2) output shortly after user INPUT is reactive
// (echo, scroll repaint) and never argues for busy; (3) the caller can MUTE
// the tracker across a known non-turn burst (the resume replay on open).
// A burst that was never announced busy also classifies as a blip, so those
// same non-turns can't fire the turn-finished side-effects.

/** Silence gap that ends a busy burst. Longer than the TUI's repaint cadence
 *  (~100ms-1s), short enough that "agent finished" lands promptly. */
export const CLI_IDLE_MS = 2000;
/** A burst must last this long to count as a real turn (not a keystroke echo
 *  or a one-off repaint). */
export const MIN_TURN_MS = 2500;
/** ...and produce at least this many data events. A running turn repaints far
 *  more; a stray echo or resize repaint far less. */
export const MIN_TURN_EVENTS = 5;
/** Output within this window after user input is REACTIVE (echo, scroll
 *  repaint, focus response) — it never argues for busy. A real turn's output
 *  keeps flowing long after the Enter that started it. */
export const ECHO_MS = 400;
/** The busy edge needs a burst at least this sustained... */
export const BUSY_MIN_MS = 300;
/** ...with at least this many data events. A single full-frame repaint
 *  arrives in one or two chunks; a turn's spinner ticks past this in ~½s. */
export const BUSY_MIN_EVENTS = 3;

export class CliActivityTracker {
  private busySince: number | null = null;
  private events = 0;
  private announced = false;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private mutedUntil = Number.NEGATIVE_INFINITY;

  /** User input (keystroke, wheel, focus) went TO the PTY at `now`. */
  onInput(now: number): void {
    this.lastInputAt = now;
  }

  /** Ignore busy edges until `until` — bridge a known non-turn burst (the
   *  resume replay on open). Data still counts, so classification stays
   *  honest; extends, never shortens, an existing mute. */
  muteUntil(until: number): void {
    this.mutedUntil = Math.max(this.mutedUntil, until);
  }

  /** Data arrived at `now`. Returns "busy" once per burst, when the burst has
   *  proven itself sustained AND unprompted; else null. */
  onData(now: number): "busy" | null {
    if (this.busySince === null) this.busySince = now;
    this.events++;
    if (this.announced || now < this.mutedUntil || now - this.lastInputAt < ECHO_MS) return null;
    if (this.events >= BUSY_MIN_EVENTS && now - this.busySince >= BUSY_MIN_MS) {
      this.announced = true;
      return "busy";
    }
    return null;
  }

  /** The caller's idle timer fired at `now`: the burst is over. Returns
   *  whether it was a real "turn" (worth unread side-effects) or a
   *  trivial "blip" (echo, repaint, replay). A burst that never announced
   *  busy is always a blip — muted/reactive output can't fire side-effects.
   *  Resets for the next burst either way. */
  onIdle(now: number): "turn" | "blip" {
    const duration = this.busySince === null ? 0 : now - this.busySince;
    const events = this.events;
    const announced = this.announced;
    this.busySince = null;
    this.events = 0;
    this.announced = false;
    return announced && events >= MIN_TURN_EVENTS && duration >= MIN_TURN_MS ? "turn" : "blip";
  }

  /** Hard reset (PTY exited/disposed mid-burst). Input/mute clocks survive —
   *  they describe the outside world, not the burst. */
  reset(): void {
    this.busySince = null;
    this.events = 0;
    this.announced = false;
  }
}
