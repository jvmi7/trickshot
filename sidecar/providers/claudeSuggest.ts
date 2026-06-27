// Suggested-reply generation: a self-contained, best-effort feature that runs a
// SEPARATE cheap one-shot query (NOT the main agent loop, which has tools/context
// and would pollute the chat). Kept out of the adapter so the agent-loop file
// stays focused; the provider only manages abort/supersede state and emits.

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assistantText } from "./claudeMapping";

// Suggested replies run on a cheap, fast model — a tiny text task, not agent work,
// so it must not burn Opus budget. "haiku" is a Claude Code alias for latest Haiku.
export const SUGGEST_MODEL = "haiku";
export const SUGGEST_SYSTEM =
  "You generate short suggested NEXT messages the USER might send to a coding agent, " +
  "given the recent conversation. Write them in the user's first-person voice (e.g. " +
  '"Add tests for this", "Explain the tradeoff"). Each must be concise (<= 8 words), ' +
  "distinct, and a plausible immediate follow-up. Output ONLY a JSON array of exactly 2 " +
  "strings — no prose, no markdown, no code fences.";

/** Parse the model's reply into at most 2 short suggestion strings. Tolerates a
 *  ```json fence and trailing prose; returns [] on anything unparseable (the UI
 *  renders nothing rather than throwing — best-effort feature). */
export function parseSuggestions(raw: string): string[] {
  const fenced = raw.match(/\[[\s\S]*\]/); // first JSON-array-looking span
  if (!fenced) return [];
  try {
    const arr = JSON.parse(fenced[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 2);
  } catch {
    return [];
  }
}

/** Run the one-shot suggestion query and return up to 2 parsed suggestions.
 *  Fail-soft: returns [] on any error (abort, network, model, parse) so the
 *  caller's stream never breaks on this best-effort path. */
export async function generateSuggestions(opts: {
  conversation: string;
  cliPath: string;
  projectDir: string;
  abort: AbortController;
}): Promise<string[]> {
  let text = "";
  try {
    const sq = query({
      prompt: `Recent conversation:\n\n${opts.conversation}\n\nSuggest 2 next messages I might send.`,
      options: {
        model: SUGGEST_MODEL,
        cwd: opts.projectDir,
        pathToClaudeCodeExecutable: opts.cliPath,
        // Minimal custom system prompt — NOT the heavy `claude_code` preset
        // (thousands of tokens). This is a tiny text task, so loading the full
        // agent prompt just slowed every suggestion down for no benefit.
        systemPrompt: SUGGEST_SYSTEM,
        // Pure text task: no tools, no MCP, one turn, full silent bypass.
        allowedTools: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        abortController: opts.abort,
      },
    });
    for await (const m of sq as AsyncIterable<SDKMessage>) {
      if (m.type === "assistant") text += assistantText(m);
    }
  } catch {
    // Aborted, network, model, or parse upstream — fall through to [].
  }
  return parseSuggestions(text);
}
