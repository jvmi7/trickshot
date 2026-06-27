// Inline comments — the pure, app-side data model + prompt assembly for the
// Notion-style comment threads anchored to chat text. NO svelte/api imports
// (testable in isolation, see comments.test.ts). The store wiring + mutators live
// in stores.ts; the streaming/out-of-band agent side lives in the sidecar.
//
// A comment thread is an OUT-OF-BAND conversation: each turn is sent to the
// sidecar as ONE assembled prompt string (built here) and answered by an isolated
// query that never touches the main session. The thread "memory" is the persisted
// `messages` list, replayed into every prompt — so the sidecar stays stateless.

/** One turn in a comment thread (the user's question or the agent's answer). */
export interface CommentMessage {
  role: "user" | "assistant";
  text: string;
}

/** How a comment re-finds its highlighted span in the (re-rendered) transcript: a
 *  W3C-style text-quote selector. `messageKey` is the anchored message's stable
 *  `__key`; `quote` is the exact selected text; `prefix`/`suffix` are short
 *  surrounding context to disambiguate when the quote occurs more than once. This
 *  is robust to markdown re-render (it matches rendered text, not source offsets). */
export interface CommentAnchor {
  messageKey: number;
  quote: string;
  prefix: string;
  suffix: string;
}

/** A persisted inline comment thread (per worktree). `pending` is true while an
 *  answer is streaming; `error` carries a failed turn. */
export interface CommentThread {
  id: string;
  anchor: CommentAnchor;
  /** The highlighted text (mirror of `anchor.quote`, kept for prompt context even
   *  if the anchor can't be re-applied — e.g. the message is out of the render window). */
  selectedText: string;
  messages: CommentMessage[];
  pending: boolean;
  error?: string;
  createdAt: number;
}

/** Cap the read-only context fed to the comment agent so the prompt stays bounded
 *  (the surrounding chat is background, not the thing to answer). */
const MAX_SELECTION_CHARS = 4000;

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Assemble the prompt for one comment turn from its four context layers:
 *  surrounding main-chat conversation (read-only background), the highlighted
 *  text, the prior thread Q&A, and the new question. The agent answers ONLY the
 *  new question; the rest is labeled as context. Pure + deterministic. */
export function buildCommentPrompt(args: {
  chatContext: string;
  selectedText: string;
  priorMessages: CommentMessage[];
  newQuestion: string;
}): string {
  const sections: string[] = [];

  const ctx = args.chatContext.trim();
  sections.push(
    "## Background: the main conversation this comment is about (read-only context)\n" +
      (ctx || "(no surrounding conversation available)"),
  );

  sections.push(
    "## Highlighted text the user is commenting on\n" +
      `"""\n${clamp(args.selectedText.trim(), MAX_SELECTION_CHARS)}\n"""`,
  );

  if (args.priorMessages.length > 0) {
    const thread = args.priorMessages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.trim()}`)
      .join("\n\n");
    sections.push("## This comment thread so far\n" + thread);
  }

  sections.push("## The user's question to answer now\n" + args.newQuestion.trim());

  return sections.join("\n\n");
}
