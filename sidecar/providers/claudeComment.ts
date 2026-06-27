// Inline-comment answer generation: a self-contained, out-of-band feature that
// runs a SEPARATE isolated query (NOT the main agent loop) so an inline comment
// thread never pollutes the chat's session/context or transcript. Mirrors the
// isolation recipe of claudeSuggest.ts; kept out of the adapter so the agent-loop
// file stays focused. The provider only manages per-thread abort state + streaming.
//
// Unlike `suggest`, the answer STREAMS: each assistant message maps to an
// onDelta() call so the comment popup fills in incrementally. The full thread
// context (surrounding chat + selected text + prior Q&A + new question) is
// assembled app-side and arrives as one `prompt` string — the sidecar is stateless.

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assistantText } from "./claudeMapping";

// Framing for the isolated comment agent. It answers a question ABOUT a piece of
// the chat the user highlighted, using the supplied context only (no tools, see
// below) — so the system prompt keeps it grounded and conversational.
export const COMMENT_SYSTEM =
  "You are answering a side question about a highlighted snippet from a coding " +
  "assistant's chat. You are given the surrounding conversation as read-only " +
  "background, the highlighted text, and the prior turns of this comment thread. " +
  "Answer the user's latest question directly and concisely about that snippet. " +
  "This is a private side thread — it does not affect the main conversation.";

/** Run the isolated comment query, streaming assistant text through `onDelta` as
 *  it arrives. Resolves when the turn completes; rejects only on a real failure
 *  (the caller maps that to a `comment_reply` error). An abort resolves quietly
 *  (the controller is owned by the provider's supersede/cancel logic). */
export async function streamCommentReply(opts: {
  prompt: string;
  model: string;
  cliPath: string;
  projectDir: string;
  abort: AbortController;
  onDelta: (text: string) => void;
}): Promise<void> {
  const cq = query({
    prompt: opts.prompt,
    options: {
      model: opts.model,
      cwd: opts.projectDir,
      pathToClaudeCodeExecutable: opts.cliPath,
      // Minimal custom system prompt — NOT the heavy `claude_code` preset. This is
      // a focused Q&A over supplied context, so the full agent prompt buys nothing.
      systemPrompt: COMMENT_SYSTEM,
      // Out-of-band + isolated: NO `resume` (never touches the main session), no
      // tools (pure reasoning over the provided context — keeps it write-safe), and
      // a full silent bypass. Granting read-only codebase tools is a future knob.
      allowedTools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController: opts.abort,
    },
  });
  for await (const m of cq as AsyncIterable<SDKMessage>) {
    if (m.type === "assistant") {
      const text = assistantText(m);
      if (text) opts.onDelta(text);
    }
  }
}
