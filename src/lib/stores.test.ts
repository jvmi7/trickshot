// Pins the no-op store-mutator contract (CLAUDE.md → "A no-op mutation must
// preserve map identity"). The guard's REAL, testable guarantee is identity
// preservation: a no-op mutator returns the SAME map object, which skips the
// per-event `{...m}` allocation and stops downstream *derived* stores that
// resolve to a primitive/`null` from re-propagating.
//
// What it does NOT do (also pinned below, so the docs can't drift back to the
// old "fires no subscribers" overclaim): it does not silence a `writable`'s own
// subscribers — svelte's `safe_not_equal` flags every object value as changed,
// so a direct `$store` reader still re-runs on a same-identity set. The win is
// the allocation + the primitive-derived renders, nothing more.

import { describe, expect, test } from "bun:test";
import { get } from "svelte/store";
import {
  activeActivity,
  bumpUnread,
  clearStatus,
  clearSuggestions,
  clearUnread,
  sessionByWorktree,
  sessionStatus,
  setActivity,
  setStatus,
  setSuggestions,
  setWorktreeSession,
  startActivity,
  suggestionsByWorktree,
  unreadByWorktree,
  worktreeActivity,
} from "./stores";

describe("no-op mutators preserve map identity", () => {
  test("createWorktreeMap.remove on an absent key returns the same object", () => {
    const before = get(sessionStatus);
    clearStatus("conformance-absent");
    expect(get(sessionStatus)).toBe(before);
  });

  test("a real remove returns a fresh object without the key", () => {
    setStatus("conformance-w1", "ready");
    const before = get(sessionStatus);
    clearStatus("conformance-w1");
    const after = get(sessionStatus);
    expect(after).not.toBe(before);
    expect("conformance-w1" in after).toBe(false);
  });

  test("clearUnread on already-clear state preserves identity; a real clear does not", () => {
    const before = get(unreadByWorktree);
    clearUnread("conformance-absent"); // absent → no-op
    expect(get(unreadByWorktree)).toBe(before);

    bumpUnread("conformance-u1");
    const seeded = get(unreadByWorktree);
    clearUnread("conformance-u1"); // had a value → real change
    expect(get(unreadByWorktree)).not.toBe(seeded);
    expect(get(unreadByWorktree)["conformance-u1"]).toBe(0);
  });

  test("setActivity preserves identity on an unchanged label/detail (no step bump)", () => {
    startActivity("conformance-a1"); // { label: "Thinking", detail: "" }
    const before = get(worktreeActivity);
    setActivity("conformance-a1", "Thinking", ""); // same → no-op
    expect(get(worktreeActivity)).toBe(before);
    setActivity("conformance-a1", "Writing response", ""); // changed → fresh
    expect(get(worktreeActivity)).not.toBe(before);
  });

  test("clearSuggestions preserves identity when empty; a real clear does not", () => {
    const before = get(suggestionsByWorktree);
    clearSuggestions("conformance-absent"); // empty → no-op
    expect(get(suggestionsByWorktree)).toBe(before);

    setSuggestions("conformance-s1", ["pick a"]);
    const seeded = get(suggestionsByWorktree);
    clearSuggestions("conformance-s1"); // non-empty → real change
    expect(get(suggestionsByWorktree)).not.toBe(seeded);
    expect(get(suggestionsByWorktree)["conformance-s1"]).toEqual([]);
  });

  test("setWorktreeSession preserves identity on an unchanged id", () => {
    setWorktreeSession("conformance-k1", "sid-1");
    const before = get(sessionByWorktree);
    setWorktreeSession("conformance-k1", "sid-1"); // same id → no-op
    expect(get(sessionByWorktree)).toBe(before);
    setWorktreeSession("conformance-k1", "sid-2"); // changed → fresh
    expect(get(sessionByWorktree)).not.toBe(before);
  });
});

describe("svelte store semantics the guard does NOT change (the limitation)", () => {
  test("a same-identity no-op STILL notifies a direct writable subscriber", () => {
    // safe_not_equal treats any object as changed, so identity preservation does
    // not suppress the writable's own subscribers — only the allocation + any
    // primitive/null-returning derived. This is the fact the old docs got wrong.
    let calls = 0;
    const unsub = unreadByWorktree.subscribe(() => calls++);
    const afterInit = calls; // initial synchronous fire
    clearUnread("conformance-absent-2"); // no-op, same identity
    expect(calls).toBe(afterInit + 1);
    unsub();
  });

  test("a primitive/null-returning derived does NOT re-fire on an unrelated change", () => {
    // With no worktree selected, activeActivity resolves to `null`; mutating some
    // OTHER worktree's activity recomputes the derived to `null` again, so it
    // does not propagate (this IS the benefit identity preservation extends).
    let calls = 0;
    const unsub = activeActivity.subscribe(() => calls++);
    const afterInit = calls;
    setActivity("conformance-unrelated", "Thinking", "");
    expect(calls).toBe(afterInit);
    unsub();
  });
});
