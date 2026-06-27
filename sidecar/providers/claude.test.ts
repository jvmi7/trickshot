// Unit tests for the Claude native -> neutral AgentMessage mapping plus the pure
// helpers (suggestion parsing, model ratings). Run via `bun test`. `toNeutral` is
// the one piece of provider logic with real branching; the rest of the adapter is
// I/O against the SDK.

import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { toNeutral } from "./claudeMapping";
import { ratings } from "./claudeModels";
import { parseSuggestions } from "./claudeSuggest";

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

  test("assistant tool_use with missing id/name -> empty-string fallbacks", () => {
    const out = toNeutral(
      asMsg({ type: "assistant", message: { content: [{ type: "tool_use", input: {} }] } }),
    );
    expect(out).toEqual([{ type: "tool_call", id: "", name: "", input: {} }]);
  });

  test("mixed-block assistant message -> one neutral message per block, in order", () => {
    const out = toNeutral(
      asMsg({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "running it" },
            { type: "tool_use", id: "t9", name: "Bash", input: { cmd: "ls" } },
          ],
        },
      }),
    );
    expect(out).toEqual([
      { type: "assistant", text: "running it" },
      { type: "tool_call", id: "t9", name: "Bash", input: { cmd: "ls" } },
    ]);
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

  test("subagent parent_tool_use_id propagates as parentId on every message type", () => {
    const assistant = toNeutral(
      asMsg({
        type: "assistant",
        parent_tool_use_id: "agent-1",
        message: { content: [{ type: "text", text: "sub" }] },
      }),
    );
    expect(assistant).toEqual([{ type: "assistant", text: "sub", parentId: "agent-1" }]);

    const result = toNeutral(
      asMsg({
        type: "user",
        parent_tool_use_id: "agent-1",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      }),
    );
    expect(result).toEqual([
      { type: "tool_result", id: "t1", content: "ok", isError: false, parentId: "agent-1" },
    ]);
  });

  test("result with usage -> turn_end carrying mapped TurnUsage", () => {
    const out = toNeutral(
      asMsg({
        type: "result",
        total_cost_usd: 0.42,
        num_turns: 3,
        duration_ms: 1200,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 2,
        },
      }),
    );
    expect(out).toEqual([
      {
        type: "turn_end",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheCreationTokens: 2,
          costUsd: 0.42,
          numTurns: 3,
          durationMs: 1200,
        },
      },
    ]);
  });

  test("bare result (no usage figures) -> plain turn_end", () => {
    expect(toNeutral(asMsg({ type: "result" }))).toEqual([{ type: "turn_end" }]);
    // An error subtype with only a subtype field still has no usage figures.
    expect(toNeutral(asMsg({ type: "result", subtype: "error_max_turns" }))).toEqual([
      { type: "turn_end" },
    ]);
  });

  test("unknown/system types render nothing", () => {
    expect(toNeutral(asMsg({ type: "system", subtype: "init" }))).toEqual([]);
    expect(toNeutral(asMsg({ type: "stream_event" }))).toEqual([]);
  });

  test("assistant with no content array is empty, not a throw", () => {
    expect(toNeutral(asMsg({ type: "assistant", message: {} }))).toEqual([]);
  });
});

describe("parseSuggestions", () => {
  test("plain JSON array -> trimmed, capped at 2", () => {
    expect(parseSuggestions('[" a ", "b", "c"]')).toEqual(["a", "b"]);
  });

  test("```json fence with trailing prose is tolerated", () => {
    expect(parseSuggestions('Sure!\n```json\n["x", "y"]\n```\nHope that helps')).toEqual([
      "x",
      "y",
    ]);
  });

  test("non-array / garbage / non-strings -> []", () => {
    expect(parseSuggestions("not json at all")).toEqual([]);
    expect(parseSuggestions('{"a":1}')).toEqual([]);
    expect(parseSuggestions("[1, 2, 3]")).toEqual([]);
    expect(parseSuggestions("[ broken")).toEqual([]);
  });
});

describe("ratings", () => {
  const score = (meta: ReturnType<typeof ratings>, label: string) =>
    meta?.find((r) => r.label === label)?.score;

  test("opus skews to reasoning, haiku to speed", () => {
    const opus = ratings("claude-opus-4-8", "Opus 4.8");
    expect(score(opus, "Reasoning")).toBe(4);
    const haiku = ratings("haiku", "Haiku 4.5");
    expect(score(haiku, "Speed")).toBe(4);
  });

  test("a 1m-context model bumps the Context pip to 4", () => {
    expect(score(ratings("claude-sonnet-4-6[1m]", "Sonnet 1M"), "Context")).toBe(4);
    expect(score(ratings("claude-sonnet-4-6", "Sonnet"), "Context")).toBe(2);
  });
});
