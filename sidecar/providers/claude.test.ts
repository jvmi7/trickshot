// Unit tests for the Claude native -> neutral AgentMessage mapping. Run via
// `bun test`. `toNeutral` is the one piece of provider logic with real branching;
// the rest of the adapter is I/O against the SDK.

import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { toNeutral } from "./claude";

// The SDK's SDKMessage is a large union; tests build the minimal shape each branch
// reads and cast through `unknown` (toNeutral defensively probes fields anyway).
const asMsg = (o: unknown) => o as SDKMessage;

describe("toNeutral", () => {
  test("assistant text -> assistant message", () => {
    const out = toNeutral(
      asMsg({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    );
    expect(out).toEqual([{ type: "assistant", text: "hi" }]);
  });

  test("assistant tool_use -> tool_call (stringly-typed ids)", () => {
    const out = toNeutral(
      asMsg({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] },
      }),
    );
    expect(out).toEqual([{ type: "tool_call", id: "t1", name: "Bash", input: { cmd: "ls" } }]);
  });

  test("user tool_result string content -> tool_result", () => {
    const out = toNeutral(
      asMsg({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "done", is_error: false }],
        },
      }),
    );
    expect(out).toEqual([{ type: "tool_result", id: "t1", content: "done", isError: false }]);
  });

  test("user tool_result non-string content is JSON-stringified; is_error maps", () => {
    const out = toNeutral(
      asMsg({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t2", content: { a: 1 }, is_error: true }],
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "tool_result", id: "t2", isError: true });
    expect((out[0] as { content: string }).content).toContain('"a": 1');
  });

  test("result -> turn_end", () => {
    expect(toNeutral(asMsg({ type: "result" }))).toEqual([{ type: "turn_end" }]);
  });

  test("unknown/system types render nothing", () => {
    expect(toNeutral(asMsg({ type: "system", subtype: "init" }))).toEqual([]);
    expect(toNeutral(asMsg({ type: "stream_event" }))).toEqual([]);
  });

  test("assistant with no content array is empty, not a throw", () => {
    expect(toNeutral(asMsg({ type: "assistant", message: {} }))).toEqual([]);
  });
});
