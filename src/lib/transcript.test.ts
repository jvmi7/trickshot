import { describe, expect, test } from "bun:test";
import {
  appendMessage,
  bufferedMessages,
  groupMessages,
  hiddenCount,
  indexToolResults,
  RENDER_WINDOW,
  summarizeConversation,
  windowTail,
} from "./transcript";
import type { TranscriptMessage } from "./types";

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
});
