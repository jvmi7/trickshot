import { describe, expect, test } from "bun:test";
import { get } from "svelte/store";
import { flushScriptOutput, handleScriptEvent } from "./scriptEvents";
import { scriptRunByWorktree } from "./stores";

// A fresh worktree key per test so store state never collides across tests.
let n = 0;
const wt = () => `scriptEvents-test-${n++}`;
const tick = () => new Promise((r) => setTimeout(r, 25)); // > the 16ms output flush

describe("handleScriptEvent lifecycle", () => {
  test("started → a fresh running run named by data", () => {
    const w = wt();
    handleScriptEvent(w, "started", "dev");
    const run = get(scriptRunByWorktree)[w];
    expect(run).toEqual({ name: "dev", status: "running", code: null, output: [] });
  });

  test("stdout/stderr lines coalesce into ONE flush (batched, ordered)", async () => {
    const w = wt();
    handleScriptEvent(w, "started", "dev");
    let writes = 0;
    const unsub = scriptRunByWorktree.subscribe(() => writes++);
    const before = writes;
    handleScriptEvent(w, "stdout", "line 1");
    handleScriptEvent(w, "stderr", "line 2");
    handleScriptEvent(w, "stdout", "line 3");
    expect(writes).toBe(before); // nothing lands before the flush window
    await tick();
    expect(get(scriptRunByWorktree)[w]?.output).toEqual(["line 1", "line 2", "line 3"]);
    expect(writes).toBe(before + 1); // one store write for the whole burst
    unsub();
  });

  test("exit flushes buffered output BEFORE marking exited, and parses the code", () => {
    const w = wt();
    handleScriptEvent(w, "started", "test");
    handleScriptEvent(w, "stdout", "tail line");
    handleScriptEvent(w, "exit", "2");
    const run = get(scriptRunByWorktree)[w];
    expect(run?.output).toEqual(["tail line"]); // no post-exit stragglers
    expect(run?.status).toBe("exited");
    expect(run?.code).toBe(2);
  });

  test("exit with null data (killed) yields a null code", () => {
    const w = wt();
    handleScriptEvent(w, "started", "dev");
    handleScriptEvent(w, "exit", null);
    expect(get(scriptRunByWorktree)[w]?.code).toBeNull();
  });

  test("a new started drops the previous run's unflushed lines", async () => {
    const w = wt();
    handleScriptEvent(w, "started", "old");
    handleScriptEvent(w, "stdout", "stale line");
    handleScriptEvent(w, "started", "new"); // restart before the 16ms flush
    await tick();
    const run = get(scriptRunByWorktree)[w];
    expect(run?.name).toBe("new");
    expect(run?.output).toEqual([]); // the stale buffer never landed
  });

  test("flushScriptOutput drains immediately (no timer wait)", () => {
    const w = wt();
    handleScriptEvent(w, "started", "dev");
    handleScriptEvent(w, "stdout", "now");
    flushScriptOutput();
    expect(get(scriptRunByWorktree)[w]?.output).toEqual(["now"]);
  });
});
