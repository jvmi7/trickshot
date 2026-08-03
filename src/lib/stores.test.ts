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
  activeGitStat,
  bumpUnread,
  clearStatus,
  clearUnread,
  sessionStatus,
  setGitStat,
  setStatus,
  unreadByWorktree,
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
    // With no worktree selected, activeGitStat resolves to `null`; mutating some
    // OTHER worktree's stat recomputes the derived to `null` again, so it does
    // not propagate (this IS the benefit identity preservation extends).
    let calls = 0;
    const unsub = activeGitStat.subscribe(() => calls++);
    const afterInit = calls;
    setGitStat("conformance-unrelated", {
      changed: 1,
      insertions: 1,
      deletions: 0,
      aheadOfDefault: 0,
    });
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

import { moveRepoTo, repos } from "./stores";

describe("moveRepoTo", () => {
  const seed = () => {
    repos.set([
      { path: "/a", name: "a" },
      { path: "/b", name: "b" },
      { path: "/c", name: "c" },
    ]);
  };
  const order = () => get(repos).map((r) => r.path);

  test("moves a repo to the drop slot (current-list semantics)", () => {
    seed();
    moveRepoTo("/a", 3); // drop after the last
    expect(order()).toEqual(["/b", "/c", "/a"]);
    moveRepoTo("/a", 0); // back to the front
    expect(order()).toEqual(["/a", "/b", "/c"]);
    moveRepoTo("/c", 1); // between a and b
    expect(order()).toEqual(["/a", "/c", "/b"]);
  });

  test("no-op moves preserve list identity (the same-map guard rule)", () => {
    seed();
    const before = get(repos);
    moveRepoTo("/b", 1); // dropping onto its own slot
    expect(get(repos)).toBe(before);
    moveRepoTo("/b", 2); // the slot just below itself is ALSO its own position
    expect(get(repos)).toBe(before);
    moveRepoTo("/missing", 0); // unknown path
    expect(get(repos)).toBe(before);
  });
});

import { moveWorktreeTo, orderWorktrees, setWorktrees, worktreeOrderByRepo } from "./stores";
import type { Worktree } from "./types";

describe("worktree ordering (the reorder-drag overlay)", () => {
  const wt = (path: string): Worktree =>
    ({ path, branch: path, is_main: false, is_bare: false }) as Worktree;

  test("orderWorktrees: no saved order → git order untouched", () => {
    const list = [wt("/m"), wt("/a")];
    expect(orderWorktrees(list, undefined)).toBe(list);
    expect(orderWorktrees(list, [])).toBe(list);
  });

  test("orderWorktrees: knowns sort by saved index, unknowns append in git order", () => {
    const list = [wt("/m"), wt("/a"), wt("/new1"), wt("/new2")];
    const out = orderWorktrees(list, ["/a", "/m"]).map((w) => w.path);
    expect(out).toEqual(["/a", "/m", "/new1", "/new2"]);
  });

  test("orderWorktrees: stale saved paths are ignored", () => {
    const out = orderWorktrees([wt("/m")], ["/gone", "/m"]).map((w) => w.path);
    expect(out).toEqual(["/m"]);
  });

  test("moveWorktreeTo uses drop-slot semantics over the DISPLAYED order", () => {
    setWorktrees("/repo", [wt("/m"), wt("/a"), wt("/b")]);
    worktreeOrderByRepo.set({});
    moveWorktreeTo("/repo", "/m", 3); // drop after the last
    expect(get(worktreeOrderByRepo)["/repo"]).toEqual(["/a", "/b", "/m"]);
    moveWorktreeTo("/repo", "/b", 0); // to the front of the NEW order
    expect(get(worktreeOrderByRepo)["/repo"]).toEqual(["/b", "/a", "/m"]);
  });

  test("moveWorktreeTo no-ops on own-slot drops and unknown paths", () => {
    setWorktrees("/repo", [wt("/m"), wt("/a")]);
    worktreeOrderByRepo.set({});
    moveWorktreeTo("/repo", "/m", 0); // its own slot
    moveWorktreeTo("/repo", "/m", 1); // the slot just below itself
    moveWorktreeTo("/repo", "/missing", 0);
    expect(get(worktreeOrderByRepo)["/repo"]).toBeUndefined();
  });
});
