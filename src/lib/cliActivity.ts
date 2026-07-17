// Busy/idle detection for the Claude CLI PTY, derived from its output flow.
// The TUI repaints continuously while a turn runs (spinner + elapsed-time
// ticker) and is silent when idle (xterm blinks the cursor client-side), so
// "data is flowing" IS the busy signal — no protocol events exist on this
// path (the sidecar's turn_end never fires under CLI-first chat). Pure state
// machine: the caller owns the timers and passes timestamps in, so the edge
// logic is unit-testable (terminal.ts wires it to the real stream).

/** Silence gap that ends a busy burst. Longer than the TUI's repaint cadence
 *  (~100ms-1s), short enough that "agent finished" lands promptly. */
export const CLI_IDLE_MS = 2000;
/** A burst must last this long to count as a real turn (not a keystroke echo
 *  or a one-off repaint). */
export const MIN_TURN_MS = 2500;
/** ...and produce at least this many data events. A running turn repaints far
 *  more; a stray echo or resize repaint far less. */
export const MIN_TURN_EVENTS = 5;

export class CliActivityTracker {
  private busySince: number | null = null;
  private events = 0;

  /** Data arrived at `now`. Returns "busy" on the idle→busy edge, else null. */
  onData(now: number): "busy" | null {
    this.events++;
    if (this.busySince === null) {
      this.busySince = now;
      return "busy";
    }
    return null;
  }

  /** The caller's idle timer fired at `now`: the burst is over. Returns
   *  whether it was a real "turn" (worth unread/notify side-effects) or a
   *  trivial "blip" (echo, repaint). Resets for the next burst either way. */
  onIdle(now: number): "turn" | "blip" {
    const duration = this.busySince === null ? 0 : now - this.busySince;
    const events = this.events;
    this.busySince = null;
    this.events = 0;
    return events >= MIN_TURN_EVENTS && duration >= MIN_TURN_MS ? "turn" : "blip";
  }

  /** Hard reset (PTY exited/disposed mid-burst). */
  reset(): void {
    this.busySince = null;
    this.events = 0;
  }
}
