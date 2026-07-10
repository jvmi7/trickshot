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

// ---- Archived workspaces (archive/restore index) ----
// Imported lazily here (not in the header import) to keep this append-only vs
// concurrent edits to the main import list.
import {
  addArchived,
  appendScriptLines,
  archivedWorkspaces,
  endScriptRun,
  removeArchived,
  scriptRunByWorktree,
  startScriptRun,
} from "./stores";

describe("archivedWorkspaces mutators", () => {
  const entry = (branch: string, at = 1) => ({
    repoPath: "/tmp/repo-arch",
    repoName: "repo-arch",
    branch,
    path: `/tmp/.repo-arch-worktrees/${branch}`,
    archivedAt: at,
  });

  test("addArchived appends and re-archiving the same repo+branch replaces (no dupes)", () => {
    addArchived(entry("feat-a", 1));
    addArchived(entry("feat-b", 2));
    addArchived(entry("feat-a", 3)); // re-archive
    const list = get(archivedWorkspaces).filter((a) => a.repoPath === "/tmp/repo-arch");
    expect(list.map((a) => a.branch).sort()).toEqual(["feat-a", "feat-b"]);
    expect(list.find((a) => a.branch === "feat-a")?.archivedAt).toBe(3); // the newer entry won
  });

  test("removeArchived drops exactly the matching repo+branch", () => {
    removeArchived("/tmp/repo-arch", "feat-a");
    const list = get(archivedWorkspaces).filter((a) => a.repoPath === "/tmp/repo-arch");
    expect(list.map((a) => a.branch)).toEqual(["feat-b"]);
    removeArchived("/tmp/repo-arch", "feat-b");
  });
});

// ---- Moved subsystems, still imported from "./stores" ----
// session.ts (queued follow-ups) and threads.ts are split out of stores.ts but
// re-exported from it — these tests import through "./stores" ON PURPOSE, pinning
// both the re-export compatibility and the circular-import wiring (a TDZ in the
// stores ↔ session/threads cycle would fail right here at import time).
import {
  addComment,
  appendCommentDelta,
  clearQueued,
  commentsByWorktree,
  enqueueMessage,
  openThreadFor,
  queuedByWorktree,
  removeQueued,
} from "./stores";

describe("queued follow-ups (session.ts via the stores re-export)", () => {
  test("enqueueMessage trims, assigns stable ids; blank text is a no-op", () => {
    const w = "stores-test-queue";
    enqueueMessage(w, "  first  ");
    enqueueMessage(w, "   "); // blank → no-op
    enqueueMessage(w, "second");
    const q = get(queuedByWorktree)[w] ?? [];
    expect(q.map((m) => m.text)).toEqual(["first", "second"]);
    expect(new Set(q.map((m) => m.id)).size).toBe(2); // ids are unique
  });

  test("removeQueued drops exactly the matching id", () => {
    const w = "stores-test-queue";
    const first = (get(queuedByWorktree)[w] ?? [])[0];
    if (!first) throw new Error("seed missing");
    removeQueued(w, first.id);
    expect((get(queuedByWorktree)[w] ?? []).map((m) => m.text)).toEqual(["second"]);
  });

  test("clearQueued empties the queue; a no-op clear preserves map identity", () => {
    const w = "stores-test-queue";
    clearQueued(w);
    expect(get(queuedByWorktree)[w]).toEqual([]);
    const before = get(queuedByWorktree);
    clearQueued(w); // already empty → same identity (the no-op guard)
    expect(get(queuedByWorktree)).toBe(before);
  });
});

describe("threads (threads.ts via the stores re-export)", () => {
  test("openThreadFor creates one thread per message key and reuses it", () => {
    const w = "stores-test-threads";
    openThreadFor(w, 42);
    openThreadFor(w, 42); // same anchor → reuse, no duplicate
    const list = get(commentsByWorktree)[w] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.messageKey).toBe(42);
  });

  test("appendCommentDelta extends a streaming answer or starts one", () => {
    const w = "stores-test-threads-delta";
    addComment(w, { id: "t1", messageKey: 1, messages: [], pending: false, createdAt: 0 });
    appendCommentDelta(w, "t1", "Hel");
    appendCommentDelta(w, "t1", "lo"); // same turn → merged into one message
    const t = (get(commentsByWorktree)[w] ?? [])[0];
    expect(t?.messages).toEqual([{ role: "assistant", text: "Hello" }]);
  });
});

describe("script-run store", () => {
  test("appendScriptLines keeps the bounded tail (2000) and preserves order", () => {
    const w = "stores-test-script-tail";
    startScriptRun(w, "flood");
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
    appendScriptLines(w, lines);
    const run = get(scriptRunByWorktree)[w];
    expect(run?.output.length).toBe(2000);
    expect(run?.output[0]).toBe("line 500"); // oldest 500 trimmed
    expect(run?.output[1999]).toBe("line 2499");
  });

  test("endScriptRun marks exited with the code, keeping output", () => {
    const w = "stores-test-script-exit";
    startScriptRun(w, "dev");
    appendScriptLines(w, ["hello"]);
    endScriptRun(w, 1);
    const run = get(scriptRunByWorktree)[w];
    expect(run?.status).toBe("exited");
    expect(run?.code).toBe(1);
    expect(run?.output).toEqual(["hello"]);
  });
});
