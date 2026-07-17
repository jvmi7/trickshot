import { describe, expect, test } from "bun:test";
import { CLI_IDLE_MS, CliActivityTracker, MIN_TURN_EVENTS, MIN_TURN_MS } from "./cliActivity";

describe("CliActivityTracker", () => {
  test("fires busy only on the idle→busy edge", () => {
    const t = new CliActivityTracker();
    expect(t.onData(0)).toBe("busy");
    expect(t.onData(100)).toBeNull();
    expect(t.onData(200)).toBeNull();
    // After the burst ends, the next data is a fresh edge.
    t.onIdle(200 + CLI_IDLE_MS);
    expect(t.onData(5000)).toBe("busy");
  });

  test("a long dense burst is a turn", () => {
    const t = new CliActivityTracker();
    for (let i = 0; i < MIN_TURN_EVENTS; i++) t.onData(i * 1000);
    expect(t.onIdle(MIN_TURN_EVENTS * 1000 + CLI_IDLE_MS)).toBe("turn");
  });

  test("a keystroke echo is a blip (too few events)", () => {
    const t = new CliActivityTracker();
    t.onData(0);
    expect(t.onIdle(CLI_IDLE_MS + MIN_TURN_MS)).toBe("blip");
  });

  test("a dense but instant repaint is a blip (too short)", () => {
    const t = new CliActivityTracker();
    for (let i = 0; i < MIN_TURN_EVENTS * 2; i++) t.onData(i);
    expect(t.onIdle(MIN_TURN_MS - 1)).toBe("blip");
  });

  test("onIdle resets state so bursts don't accumulate", () => {
    const t = new CliActivityTracker();
    for (let i = 0; i < MIN_TURN_EVENTS - 1; i++) t.onData(i * 1000);
    t.onIdle(10_000); // blip — but must also reset the counters
    t.onData(20_000);
    expect(t.onIdle(20_000 + MIN_TURN_MS)).toBe("blip");
  });

  test("reset clears a burst in progress", () => {
    const t = new CliActivityTracker();
    for (let i = 0; i < MIN_TURN_EVENTS; i++) t.onData(i * 1000);
    t.reset();
    expect(t.onIdle(60_000)).toBe("blip");
    expect(t.onData(61_000)).toBe("busy");
  });
});
