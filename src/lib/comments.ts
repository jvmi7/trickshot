// DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
// (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
// "Deprecated GUI surface" before extending.
// Threads — the pure, app-side data model + prompt assembly for the Slack-style
// per-message threads. NO svelte/api imports (testable in isolation, see
// comments.test.ts). The store wiring + mutators live in stores.ts; the streaming
// agent side lives in the sidecar. (Kept the `comment*` naming internally to match
// the existing wire protocol / sidecar — the UI calls these "threads".)
//
// A thread is an OUT-OF-BAND side-conversation anchored to ONE agent message: each
// turn is sent to the sidecar as ONE assembled prompt string (built here) carrying
// the full main conversation up to that message + the thread's own history, so the
// agent answers with full context WITHOUT the thread polluting the main transcript.
// The thread "memory" is the persisted `messages` list, replayed into every prompt
// — so the sidecar stays stateless.

/** One turn in a thread (the user's question or the agent's answer). */
export interface CommentMessage {
  role: "user" | "assistant";
  text: string;
}

/** A persisted thread, one per anchored agent message. `messageKey` is that
 *  message's stable transcript `__key`. `pending` is true while an answer streams;
 *  `error` carries a failed turn. */
export interface CommentThread {
  id: string;
  messageKey: number;
  messages: CommentMessage[];
  pending: boolean;
  /** When the current pending turn started (ms epoch), for the elapsed timer in
   *  the thinking indicator. Set when `pending` flips true; stale (ignored) once
   *  `pending` is false. */
  pendingSince?: number;
  error?: string;
  createdAt: number;
}

/** Generous caps so the seeded context stays bounded on long chats without losing
 *  the point (the anchored message + recent conversation are what matter most). */
const MAX_ANCHOR_CHARS = 4000;
const MAX_CONTEXT_CHARS = 16000;

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Assemble the prompt for one thread turn from its layers: the full main-chat
 *  conversation up to the anchored message (context), the specific message being
 *  replied to, the prior thread Q&A, and the new question. The agent answers ONLY
 *  the new question; the rest is labeled context. Pure + deterministic. */
export function buildCommentPrompt(args: {
  conversation: string;
  anchoredMessage: string;
  priorMessages: CommentMessage[];
  newQuestion: string;
}): string {
  const sections: string[] = [];

  const convo = args.conversation.trim();
  sections.push(
    "## Our conversation so far (context)\n" +
      (convo ? clamp(convo, MAX_CONTEXT_CHARS) : "(no earlier conversation)"),
  );

  sections.push(
    "## The specific message of yours I'm replying to\n" +
      `"""\n${clamp(args.anchoredMessage.trim(), MAX_ANCHOR_CHARS)}\n"""`,
  );

  if (args.priorMessages.length > 0) {
    const thread = args.priorMessages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.trim()}`)
      .join("\n\n");
    sections.push("## This thread so far\n" + thread);
  }

  sections.push("## My message to answer now\n" + args.newQuestion.trim());

  return sections.join("\n\n");
}