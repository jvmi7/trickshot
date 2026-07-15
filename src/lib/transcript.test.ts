import { afterAll, describe, expect, test } from "bun:test";
import { get } from "svelte/store";
import {
  appendMessage,
  bufferedMessages,
  groupMessages,
  hiddenCount,
  indexToolResults,
  loadTranscripts,
  migrateTranscriptsV2,
  RENDER_WINDOW,
  resetTranscript,
  saveDirtyTranscripts,
  summarizeConversation,
  type TranscriptStorage,
  transcriptKey,
  transcripts,
  windowTail,
} from "./transcript";
import type { TranscriptMessage } from "./types";

const tick = () => new Promise((r) => setTimeout(r, 25)); // > the 16ms append flush

// Helpers build transcript messages with a `__key` so grouping keys are stable.
let k = 0;
function call(id: string, name = "Bash"): TranscriptMessage {
  return { type: "tool_call", id, name, input: {}, __key: k++ } as TranscriptMessage;
}
function result(id: string, content = "ok", isError = false): TranscriptMessage {
  return { type: "tool_result", id, content, isError, __key: k++ } as TranscriptMessage;
}
function assistant(text: string): TranscriptMessage {
  return { type: "assistant", text, __key: k++ } as TranscriptMessage;
}
function user(text: string): TranscriptMessage {
  return { type: "user_local", text, __key: k++ } as TranscriptMessage;
}

describe("windowTail", () => {
  test("returns the input unchanged when within the window", () => {
    const msgs = [1, 2, 3];
    expect(windowTail(msgs, 5)).toBe(msgs); // same identity, not a copy
  });
  test("keeps only the newest `window` items when over", () => {
    expect(windowTail([1, 2, 3, 4, 5], 2)).toEqual([4, 5]);
  });
  test("defaults to RENDER_WINDOW", () => {
    const msgs = Array.from({ length: RENDER_WINDOW + 10 }, (_, i) => i);
    expect(windowTail(msgs)).toHaveLength(RENDER_WINDOW);
    expect(windowTail(msgs)[0]).toBe(10);
  });
});

describe("hiddenCount", () => {
  test("0 when nothing hidden", () => {
    expect(hiddenCount(10, 300)).toBe(0);
    expect(hiddenCount(300, 300)).toBe(0);
  });
  test("the overflow above the window", () => {
    expect(hiddenCount(305, 300)).toBe(5);
  });
});

describe("indexToolResults", () => {
  test("maps tool_result id -> content/isError, ignoring other types", () => {
    const msgs = [call("a"), assistant("hi"), result("a", "done"), result("b", "boom", true)];
    expect(indexToolResults(msgs)).toEqual({
      a: { content: "done", isError: false },
      b: { content: "boom", isError: true },
    });
  });
});

describe("groupMessages", () => {
  test("consecutive tool calls collapse into one tools group", () => {
    const groups = groupMessages([call("a"), call("b"), call("c")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("tools");
    if (groups[0]?.kind === "tools") expect(groups[0].tools).toHaveLength(3);
  });

  test("tool_result folds into the run without breaking it", () => {
    const groups = groupMessages([call("a"), result("a"), call("b")]);
    expect(groups).toHaveLength(1);
    if (groups[0]?.kind === "tools") expect(groups[0].tools.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("prose breaks the run; new tool calls open a fresh group", () => {
    const groups = groupMessages([call("a"), assistant("done"), call("b")]);
    expect(groups.map((g) => g.kind)).toEqual(["tools", "single", "tools"]);
  });

  test("non-tool messages each become their own single group", () => {
    const groups = groupMessages([user("hi"), assistant("hello")]);
    expect(groups.map((g) => g.kind)).toEqual(["single", "single"]);
  });

  test("group key is stable on the first member's __key", () => {
    const a = call("a");
    const groups = groupMessages([a, call("b")]);
    expect(groups[0]?.key).toBe(`g${a.__key}`);
  });

  test("empty input yields no groups", () => {
    expect(groupMessages([])).toEqual([]);
  });
});

describe("summarizeConversation", () => {
  test("includes only user/assistant turns, newest-capped", () => {
    const msgs = [user("one"), call("a"), result("a"), assistant("two")];
    expect(summarizeConversation(msgs)).toBe("User: one\nAssistant: two");
  });
  test("caps to the last maxMessages lines", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d")];
    expect(summarizeConversation(msgs, 2)).toBe("User: c\nAssistant: d");
  });
  test("truncates each line to maxChars", () => {
    expect(summarizeConversation([user("abcdef")], 8, 3)).toBe("User: abc");
  });
});

describe("appendMessage / bufferedMessages", () => {
  test("buffers an appended message before flush, with a stable __key", () => {
    const wt = `wt-${Math.random()}`;
    const before = bufferedMessages(wt).length;
    appendMessage(wt, { type: "user_local", text: "hi" });
    const buf = bufferedMessages(wt);
    expect(buf.length).toBe(before + 1);
    expect(typeof buf[buf.length - 1]?.__key).toBe("number");
  });

  test("a burst of appends coalesces into one flushed list", async () => {
    const wt = `wt-burst-${Math.random()}`;
    for (let i = 0; i < 20; i++) appendMessage(wt, { type: "user_local", text: `m${i}` });
    // All 20 sit in the buffer until the 16ms flush lands them in the store.
    expect(bufferedMessages(wt)).toHaveLength(20);
    expect(get(transcripts)[wt]).toBeUndefined();
    await tick();
    expect(bufferedMessages(wt)).toHaveLength(0);
    expect(get(transcripts)[wt]).toHaveLength(20);
  });
});

describe("resetTranscript", () => {
  test("drops the un-flushed buffer so a recreated worktree inherits nothing", async () => {
    const wt = `wt-reset-${Math.random()}`;
    appendMessage(wt, { type: "user_local", text: "stale" });
    expect(bufferedMessages(wt)).toHaveLength(1); // buffered, not yet flushed
    resetTranscript(wt);
    // Both the buffer AND the store entry must be empty immediately…
    expect(bufferedMessages(wt)).toHaveLength(0);
    expect(get(transcripts)[wt]).toEqual([]);
    // …and the dropped message must NOT reappear when the flush timer fires.
    await tick();
    expect(get(transcripts)[wt]).toEqual([]);
  });

  test("clears a previously flushed transcript", async () => {
    const wt = `wt-reset2-${Math.random()}`;
    appendMessage(wt, { type: "user_local", text: "one" });
    await tick();
    expect(get(transcripts)[wt]).toHaveLength(1);
    resetTranscript(wt);
    expect(get(transcripts)[wt]).toEqual([]);
  });
});

// ---- Per-worktree persistence (the v3 key-per-worktree scheme) ----
// bun test has no localStorage, so the pure migrate/load/save helpers are
// exercised against this in-memory shim; the end-to-end wiring tests install it
// as `globalThis.localStorage`, which works because transcript.ts resolves
// storage at CALL time (see the `storage()` comment there).
type MemoryStorage = TranscriptStorage & { data: Map<string, string>; setCalls: string[] };
function memoryStorage(failKeys: Set<string> = new Set()): MemoryStorage {
  const data = new Map<string, string>();
  const setCalls: string[] = [];
  return {
    data,
    setCalls,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      setCalls.push(k);
      if (failKeys.has(k)) throw new Error("quota exceeded");
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("migrateTranscriptsV2", () => {
  const V2_KEY = "trickshot.transcripts.v2";

  test("splits the old whole-map blob into per-worktree keys and removes it", () => {
    const s = memoryStorage();
    const a = [{ type: "user_local", text: "hi", __key: 1 }] as TranscriptMessage[];
    s.data.set(V2_KEY, JSON.stringify({ "/a": a, "/empty": [], "/junk": "not-a-list" }));
    migrateTranscriptsV2(s);
    expect(s.data.has(V2_KEY)).toBe(false);
    expect(JSON.parse(s.data.get(transcriptKey("/a")) ?? "null")).toEqual(a);
    // Empty and malformed worktree entries are dropped, not given keys.
    expect(s.data.has(transcriptKey("/empty"))).toBe(false);
    expect(s.data.has(transcriptKey("/junk"))).toBe(false);
  });

  test("is quota-tolerant: one failing write drops only that worktree", () => {
    const s = memoryStorage(new Set([transcriptKey("/big")]));
    s.data.set(
      V2_KEY,
      JSON.stringify({
        "/big": [{ type: "assistant", text: "x", __key: 1 }],
        "/ok": [{ type: "assistant", text: "y", __key: 2 }],
      }),
    );
    migrateTranscriptsV2(s); // must not throw
    expect(s.data.has(transcriptKey("/big"))).toBe(false);
    expect(s.data.has(transcriptKey("/ok"))).toBe(true);
    expect(s.data.has(V2_KEY)).toBe(false); // removed even after a partial split
  });

  test("a corrupt v2 blob is removed without migrating anything", () => {
    const s = memoryStorage();
    s.data.set(V2_KEY, "{not json");
    migrateTranscriptsV2(s); // must not throw
    expect(s.data.has(V2_KEY)).toBe(false);
    expect(s.data.size).toBe(0);
  });

  test("no v2 key → no-op", () => {
    const s = memoryStorage();
    migrateTranscriptsV2(s);
    expect(s.data.size).toBe(0);
  });
});

describe("loadTranscripts", () => {
  test("loads only prefixed keys, skipping corrupt/non-list entries", () => {
    const s = memoryStorage();
    const a = [{ type: "user_local", text: "hi", __key: 3 }] as TranscriptMessage[];
    s.data.set(transcriptKey("/a"), JSON.stringify(a));
    s.data.set(transcriptKey("/corrupt"), "{not json");
    s.data.set(transcriptKey("/not-a-list"), JSON.stringify({ nope: true }));
    s.data.set("trickshot.theme", '"dark"'); // unrelated key, ignored
    expect(loadTranscripts(s)).toEqual({ "/a": a });
  });
});

describe("saveDirtyTranscripts", () => {
  test("writes ONLY the dirty worktrees (per-worktree save granularity)", () => {
    const s = memoryStorage();
    const map = {
      "/a": [{ type: "user_local", text: "a" } as TranscriptMessage],
      "/b": [{ type: "user_local", text: "b" } as TranscriptMessage],
    };
    saveDirtyTranscripts(s, map, ["/a"]);
    expect(s.setCalls).toEqual([transcriptKey("/a")]);
    expect(s.data.has(transcriptKey("/b"))).toBe(false);
  });

  test("skips a dirty worktree with an empty transcript and swallows quota errors", () => {
    const s = memoryStorage(new Set([transcriptKey("/full")]));
    const map = {
      "/empty": [] as TranscriptMessage[],
      "/full": [{ type: "user_local", text: "x" } as TranscriptMessage],
    };
    saveDirtyTranscripts(s, map, ["/empty", "/full", "/absent"]); // must not throw
    expect(s.data.size).toBe(0);
  });
});

describe("persistence wiring (shimmed localStorage)", () => {
  // > the 600ms idle-save debounce (plus the 16ms flush).
  const idle = () => new Promise((r) => setTimeout(r, 700));
  const shim = memoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = shim;
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test("the idle save writes per-worktree keys, and only DIRTY ones on later saves", async () => {
    const wa = `/wiring-a-${Math.random()}`;
    const wb = `/wiring-b-${Math.random()}`;
    appendMessage(wa, { type: "user_local", text: "a1" });
    appendMessage(wb, { type: "user_local", text: "b1" });
    await idle();
    expect(shim.data.has(transcriptKey(wa))).toBe(true);
    expect(shim.data.has(transcriptKey(wb))).toBe(true);

    // Second burst touches ONLY wa → the save must not re-serialize wb.
    shim.setCalls.length = 0;
    appendMessage(wa, { type: "user_local", text: "a2" });
    await idle();
    expect(shim.setCalls).toEqual([transcriptKey(wa)]);
    expect(JSON.parse(shim.data.get(transcriptKey(wa)) ?? "[]")).toHaveLength(2);
  });

  test("resetTranscript removes the worktree's key immediately", async () => {
    const wt = `/wiring-reset-${Math.random()}`;
    appendMessage(wt, { type: "user_local", text: "gone" });
    await idle();
    expect(shim.data.has(transcriptKey(wt))).toBe(true);
    resetTranscript(wt);
    expect(shim.data.has(transcriptKey(wt))).toBe(false);
    // …and the pending idle save must not resurrect it (the un-dirty guard).
    await idle();
    expect(shim.data.has(transcriptKey(wt))).toBe(false);
  });
});
