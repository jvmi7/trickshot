// Claude native SDKMessage -> neutral AgentMessage mapping. This is the one piece
// of Claude provider logic with real branching, so it's isolated here (and unit-
// tested in claude.test.ts) — the rest of the adapter is just I/O against the SDK.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentMessage, TurnUsage } from "../../shared/protocol";

// Shape of one Claude content block as it crosses the native->neutral seam. The
// SDK types `message.content` as loose `unknown`; the String()/typeof guards in
// toNeutral validate each field at runtime, so this confined type just removes the
// implicit `any` from the block iteration (matches the file's other confined casts).
export type ContentBlock = {
  type?: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
};

/** The single site that reads an SDK message's `message.content` into a typed
 *  block array (loose `unknown` → `ContentBlock[]`, empty when absent). Every
 *  content walk below goes through here so the SDK-shape access lives in one place. */
function contentBlocks(msg: SDKMessage): ContentBlock[] {
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  return (Array.isArray(content) ? content : []) as ContentBlock[];
}

/** Read an assistant message's content blocks into a single concatenated string
 *  of its `text` blocks (ignores tool_use blocks). The one-shot suggestion path
 *  reuses this so it doesn't re-walk the SDK content shape. */
export function assistantText(msg: SDKMessage): string {
  let text = "";
  for (const b of contentBlocks(msg)) {
    if (b?.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}

// Map one Claude SDKMessage into zero or more neutral AgentMessages.
// Exported for unit testing (the native->neutral mapping is core correctness).
export function toNeutral(msg: SDKMessage): AgentMessage[] {
  // Non-null when the message came from a subagent (the spawning Agent tool's
  // id), forwarded thanks to forwardSubagentText. Lets the UI nest subagent work.
  const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id || undefined;
  const sub = parentId ? { parentId } : {};
  switch (msg.type) {
    case "assistant": {
      const out: AgentMessage[] = [];
      // Only `text` and `tool_use` blocks map to transcript bubbles; `thinking`
      // (extended-thinking) blocks are intentionally NOT rendered as prose.
      for (const b of contentBlocks(msg)) {
        if (b?.type === "text" && typeof b.text === "string") {
          out.push({ type: "assistant", text: b.text, ...sub });
        } else if (b?.type === "tool_use") {
          out.push({
            type: "tool_call",
            id: String(b.id ?? ""),
            name: String(b.name ?? ""),
            input: b.input,
            ...sub,
          });
        }
      }
      return out;
    }
    case "user": {
      const out: AgentMessage[] = [];
      for (const b of contentBlocks(msg)) {
        if (b?.type === "tool_result") {
          out.push({
            type: "tool_result",
            id: String(b.tool_use_id ?? ""),
            content: typeof b.content === "string" ? b.content : JSON.stringify(b.content, null, 2),
            isError: b.is_error === true,
            ...sub,
          });
        }
      }
      return out;
    }
    case "result": {
      // The result message ends a turn and carries cumulative token/cost figures
      // for it. Read defensively (the error subtype may omit some fields) and map
      // to the neutral TurnUsage; `total_cost_usd` is a client-side estimate.
      const r = msg as {
        total_cost_usd?: number;
        num_turns?: number;
        duration_ms?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      const u = r.usage ?? {};
      const usage: TurnUsage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheCreationTokens: u.cache_creation_input_tokens,
        costUsd: r.total_cost_usd,
        numTurns: r.num_turns,
        durationMs: r.duration_ms,
      };
      // Attach usage only when the result actually carried figures; a bare result
      // (e.g. the error subtype) maps to a plain turn_end (usage is optional).
      const hasUsage = Object.values(usage).some((v) => v !== undefined);
      return [hasUsage ? { type: "turn_end", usage } : { type: "turn_end" }];
    }
    default:
      // `system`/init carries the session id (handled in the loop); stream/partial
      // internal types render nothing.
      return [];
  }
}
