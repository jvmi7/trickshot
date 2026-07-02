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

import { describe, expect, spyOn, test } from "bun:test";
import { get } from "svelte/store";
import * as api from "./api";
import {
  activeActivity,
  bumpUnread,
  clearStatus,
  clearSuggestions,
  clearUnread,
  createPersisted,
  sessionByWorktree,
  sessionStatus,
  setActivity,
  setStatus,
  setSuggestions,
  setWorktreeSession,
  startActivity,
  submitUserTurn,
  suggestionsByWorktree,
  transcripts,
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

// ---- The persistence template (createPersisted) ----
// Every `trickshot.*` store is a copy of this ONE template, so its guards are
// pinned here: a regression in the shape fallback or the quota swallow would
// corrupt every persisted store at once. Storage exists in bun tests via the
// preloaded stub (testSetup.ts, wired in bunfig.toml).
describe("createPersisted (the persistence template)", () => {
  let n = 0;
  const key = () => `trickshot.test.persist-${n++}`;

  test("round-trips: a set value is written through and loaded by a fresh store", () => {
    const k = key();
    const a = createPersisted<number[]>(k, []);
    a.set([1, 2, 3]);
    expect(localStorage.getItem(k)).toBe("[1,2,3]");
    // A store created later on the same key loads the persisted value.
    expect(get(createPersisted<number[]>(k, []))).toEqual([1, 2, 3]);
  });

  test("garbage in storage → the fallback (a parse throw is caught)", () => {
    const k = key();
    localStorage.setItem(k, "not json{{{");
    expect(get(createPersisted(k, "fallback"))).toBe("fallback");
  });

  test("a shape-guarding parse rejects wrong-shaped data to the fallback", () => {
    const k = key();
    localStorage.setItem(k, JSON.stringify({ an: "object" }));
    const store = createPersisted<string[]>(k, [], {
      parse: (raw) => {
        const v = JSON.parse(raw);
        if (!Array.isArray(v)) throw new Error("bad shape");
        return v;
      },
    });
    expect(get(store)).toEqual([]);
  });

  test("a storage write failure (quota) is swallowed; the in-memory value still updates", () => {
    const k = key();
    const store = createPersisted<string>(k, "start");
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(() => store.set("bigger")).not.toThrow();
      expect(get(store)).toBe("bigger");
    } finally {
      localStorage.setItem = orig;
    }
  });
});

// ---- submitUserTurn — the one user-turn entry point ----
describe("submitUserTurn on IPC failure", () => {
  test("a rejected send appends an error bubble and unsticks the session", async () => {
    const w = "stores-test-submit-fail";
    const spy = spyOn(api, "sendUserTurn").mockRejectedValue(new Error("boom"));
    await submitUserTurn(w, "hello");
    await new Promise((r) => setTimeout(r, 25)); // > the 16ms append flush
    const msgs = get(transcripts)[w] ?? [];
    expect(msgs.at(0)).toMatchObject({ type: "user_local", text: "hello" });
    expect(msgs.at(-1)).toMatchObject({ type: "error" });
    // Without the catch, the composer would spin busy forever.
    expect(get(sessionStatus)[w]).toBe("ready");
    expect(get(worktreeActivity)[w]).toBeUndefined();
    spy.mockRestore();
  });
});
