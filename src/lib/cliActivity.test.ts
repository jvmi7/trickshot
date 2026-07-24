import { describe, expect, test } from "bun:test";
import {
  BUSY_MIN_EVENTS,
  BUSY_MIN_MS,
  CLI_IDLE_MS,
  CliActivityTracker,
  ECHO_MS,
  MIN_TURN_EVENTS,
  MIN_TURN_MS,
} from "./cliActivity";

/** Feed `n` data events starting at `start`, `gap` ms apart (a TUI repaint
 *  cadence); returns the announced edge if any fired. */
function burst(t: CliActivityTracker, start: number, n: number, gap = 150): "busy" | null {
  let edge: "busy" | null = null;
  for (let i = 0; i < n; i++) edge = t.onData(start + i * gap) ?? edge;
  return edge;
}

describe("CliActivityTracker", () => {
  test("busy needs a sustained burst, then fires exactly once", () => {
    const t = new CliActivityTracker();
    // Too few / too fresh: no edge yet.
    expect(t.onData(0)).toBeNull();
    expect(t.onData(150)).toBeNull();
    // Crosses both thresholds → the one edge.
    expect(t.onData(BUSY_MIN_MS)).toBe("busy");
    expect(t.onData(BUSY_MIN_MS + 150)).toBeNull(); // announced already
    // After the burst ends, the NEXT burst must re-prove itself.
    t.onIdle(BUSY_MIN_MS + 150 + CLI_IDLE_MS);
    expect(t.onData(10_000)).toBeNull();
    expect(burst(t, 10_150, BUSY_MIN_EVENTS)).toBe("busy");
  });

  test("a one-off repaint (single dense chunk group) never goes busy", () => {
    const t = new CliActivityTracker();
    // A SIGWINCH/full-frame repaint: a few chunks within a few ms.
    expect(t.onData(0)).toBeNull();
    expect(t.onData(10)).toBeNull();
    expect(t.onData(20)).toBeNull(); // 3 events but only 20ms — not sustained
    expect(t.onIdle(20 + CLI_IDLE_MS)).toBe("blip");
  });

  test("output trailing user input is reactive — echoes/scrolls never go busy", () => {
    const t = new CliActivityTracker();
    // Continuous scroll: every repaint lands within ECHO_MS of a wheel event.
    for (let ts = 0; ts < 5000; ts += 100) {
      t.onInput(ts);
      expect(t.onData(ts + 50)).toBeNull();
    }
    // Long + dense, but never announced → still a blip (no side-effects).
    expect(t.onIdle(5000 + CLI_IDLE_MS)).toBe("blip");
  });

  test("a real turn goes busy once output outlives the echo window", () => {
    const t = new CliActivityTracker();
    t.onInput(0); // the Enter that started the turn
    expect(burst(t, 100, 3, 100)).toBeNull(); // first frames: inside ECHO_MS
    // Spinner keeps ticking well past the echo window → announce.
    expect(burst(t, ECHO_MS + 100, BUSY_MIN_EVENTS, 150)).toBe("busy");
  });

  test("muted bursts never announce and classify as blips", () => {
    const t = new CliActivityTracker();
    t.muteUntil(5000); // e.g. the --resume boot replay
    expect(burst(t, 0, 20, 150)).toBeNull();
    expect(t.onIdle(3000 + CLI_IDLE_MS)).toBe("blip");
    // After the mute expires a real burst announces again.
    expect(burst(t, 6000, BUSY_MIN_EVENTS)).toBe("busy");
  });

  test("mute extends, never shortens", () => {
    const t = new CliActivityTracker();
    t.muteUntil(10_000);
    t.muteUntil(1000); // the shorter mute must not un-mute the longer one
    expect(burst(t, 2000, 20, 150)).toBeNull();
  });

  test("a long dense announced burst is a turn", () => {
    const t = new CliActivityTracker();
    expect(burst(t, 0, MIN_TURN_EVENTS, 1000)).toBe("busy");
    expect(t.onIdle(MIN_TURN_EVENTS * 1000 + CLI_IDLE_MS)).toBe("turn");
  });

  test("a keystroke echo is a blip (too few events)", () => {
    const t = new CliActivityTracker();
    t.onData(0);
    expect(t.onIdle(CLI_IDLE_MS + MIN_TURN_MS)).toBe("blip");
  });

  test("an announced but short burst is still a blip", () => {
    const t = new CliActivityTracker();
    expect(burst(t, 0, MIN_TURN_EVENTS * 2, 150)).toBe("busy");
    expect(t.onIdle(MIN_TURN_MS - 1)).toBe("blip");
  });

  test("onIdle resets state so bursts don't accumulate", () => {
    const t = new CliActivityTracker();
    burst(t, 0, MIN_TURN_EVENTS - 1, 1000);
    t.onIdle(10_000); // blip — but must also reset the counters
    t.onData(20_000);
    expect(t.onIdle(20_000 + MIN_TURN_MS)).toBe("blip");
  });

  test("reset clears a burst in progress", () => {
    const t = new CliActivityTracker();
    burst(t, 0, MIN_TURN_EVENTS, 1000);
    t.reset();
    expect(t.onIdle(60_000)).toBe("blip");
    // The next burst starts clean and must re-prove itself.
    expect(t.onData(61_000)).toBeNull();
    expect(burst(t, 61_150, BUSY_MIN_EVENTS)).toBe("busy");
  });

  test("isBusy tracks the announced burst — the mid-turn re-open read", () => {
    const t = new CliActivityTracker();
    expect(t.isBusy).toBe(false);
    // Pre-threshold output: not busy yet (a status writer reading now must
    // see ready — the burst hasn't proven itself).
    t.onData(0);
    expect(t.isBusy).toBe(false);
    // Announced: stays true for the WHOLE burst, however long it streams —
    // this is what an idempotent ensureClaudeOpen consults mid-turn.
    burst(t, 150, BUSY_MIN_EVENTS);
    expect(t.isBusy).toBe(true);
    t.onData(30_000);
    expect(t.isBusy).toBe(true);
    // The idle edge ends it.
    t.onIdle(30_000 + CLI_IDLE_MS);
    expect(t.isBusy).toBe(false);
  });

  test("isBusy stays false through muted and reactive bursts", () => {
    const t = new CliActivityTracker();
    t.muteUntil(5_000);
    burst(t, 0, MIN_TURN_EVENTS, 200);
    expect(t.isBusy).toBe(false); // the resume boot replay must not read busy
    t.onIdle(10_000);
    t.onInput(20_000);
    t.onData(20_100); // echo
    expect(t.isBusy).toBe(false);
  });
});
