// DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
// (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
// "Deprecated GUI surface" before extending.
// The comment-thread ("threads") subsystem — split out of stores.ts by the
// transcript.ts precedent: the per-worktree thread state, its mutators, and the
// one submit path live here; the pure data model + prompt assembly stay in
// comments.ts. stores.ts re-exports everything so `import { … } from "./stores"`
// keeps working.
//
// CIRCULAR-IMPORT CONTRACT (shared with session.ts): this module and stores.ts
// import each other, which is safe under ESM live bindings ONLY as long as the
// sibling touches stores.ts's state lazily — `createWorktreeMap` is a hoisted
// function declaration (callable before stores.ts's body runs) and its `.active()`
// resolves `selectedWorktree` on first subscribe, so nothing here dereferences a
// stores.ts const at module-eval time. Keep it that way.

import { get, writable } from "svelte/store";
import * as api from "./api";
import { buildCommentPrompt, type CommentMessage, type CommentThread } from "./comments";
import { isPlainObject } from "./persist";
import { createWorktreeMap } from "./stores";
import { bufferedMessages, summarizeConversation, transcripts } from "./transcript";

/** Which inline-comment thread popup is open (its id), or null. Ephemeral, global
 *  (the selection is always within the on-screen chat); cleared on worktree switch. */
export const activeCommentId = writable<string | null>(null);
/** Open a comment thread's popup. */
export function openComment(id: string) {
  activeCommentId.set(id);
}
/** Close the open comment popup (no cancel — the caller aborts any in-flight turn). */
export function closeComment() {
  activeCommentId.set(null);
}

// ---- Per-worktree threads (Slack-style, one per agent message; persisted) ----
// A thread is an OUT-OF-BAND side-conversation (see comments.ts) anchored to one
// agent message's `__key`: turns are answered by an isolated sidecar query seeded
// with the full conversation up to that message, and NEVER enter the main
// session/transcript. Persisted so threads survive a restart. `pending`/`error`
// are runtime-only — the load guard resets them so a mid-stream crash can't leave
// a thread stuck pending. (`.v2`: the row shape changed from the old highlight-
// anchored model, so old threads are dropped on load.)
const _comments = createWorktreeMap<CommentThread[]>({
  persistKey: "trickshot.commentsByWorktree.v2",
  parse: (raw) => {
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) return {};
    const out: Record<string, CommentThread[]> = {};
    for (const [wt, list] of Object.entries(v)) {
      if (!Array.isArray(list)) continue;
      out[wt] = list
        .filter(
          (t): t is CommentThread =>
            isPlainObject(t) && typeof t.id === "string" && typeof t.messageKey === "number",
        )
        // Drop transient state: an answer can't still be streaming across a reload.
        .map((t) => ({ ...t, pending: false, error: undefined }));
    }
    return out;
  },
});
export const commentsByWorktree = _comments.store;
/** The selected worktree's comment threads (empty when none). */
export const activeComments = _comments.active<CommentThread[]>([]);

/** Update one thread in a worktree's list (no-op if absent). */
function updateThread(worktree: string, id: string, fn: (t: CommentThread) => CommentThread) {
  _comments.update(worktree, (cur) => (cur ?? []).map((t) => (t.id === id ? fn(t) : t)));
}
/** Add a new comment thread to a worktree. */
export function addComment(worktree: string, thread: CommentThread) {
  _comments.update(worktree, (cur) => [...(cur ?? []), thread]);
}
/** Remove a comment thread (e.g. an empty draft closed without sending). */
export function removeComment(worktree: string, id: string) {
  _comments.update(worktree, (cur) => (cur ?? []).filter((t) => t.id !== id));
}
/** Append a finished message (user question / agent answer) to a thread. */
export function appendCommentMessage(worktree: string, id: string, msg: CommentMessage) {
  updateThread(worktree, id, (t) => ({ ...t, messages: [...t.messages, msg] }));
}
/** Append a streamed answer delta: extend the current turn's assistant message, or
 *  start one if the last message is the user's question (no answer yet this turn). */
export function appendCommentDelta(worktree: string, id: string, text: string) {
  updateThread(worktree, id, (t) => {
    const last = t.messages[t.messages.length - 1];
    if (last && last.role === "assistant") {
      const messages = t.messages.slice(0, -1).concat({ ...last, text: last.text + text });
      return { ...t, messages };
    }
    return { ...t, messages: [...t.messages, { role: "assistant", text }] };
  });
}
/** Mark a thread's answer as streaming / settled. Stamps `pendingSince` when the
 *  turn starts so the thinking indicator's elapsed timer counts from the right t0. */
export function setCommentPending(worktree: string, id: string, pending: boolean) {
  updateThread(worktree, id, (t) => ({
    ...t,
    pending,
    pendingSince: pending ? Date.now() : t.pendingSince,
  }));
}
/** Record a failed comment turn (also clears pending). */
export function setCommentError(worktree: string, id: string, error: string) {
  updateThread(worktree, id, (t) => ({ ...t, pending: false, error }));
}
/** Drop ALL comments for a worktree (on transcript reset / worktree removal so
 *  orphaned anchors don't linger). Same no-op identity guard as the map factory. */
export const removeComments = _comments.remove;

/** Open the thread for an agent message (by its transcript `__key`), creating an
 *  empty one if none exists yet. The single entry point the chat uses, so Message
 *  stays a store-free primitive (it just calls a handler). */
export function openThreadFor(worktree: string, messageKey: number) {
  const existing = (get(commentsByWorktree)[worktree] ?? []).find(
    (t) => t.messageKey === messageKey,
  );
  if (existing) {
    openComment(existing.id);
    return;
  }
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `t-${messageKey}`;
  addComment(worktree, { id, messageKey, messages: [], pending: false, createdAt: Date.now() });
  openComment(id);
}

/** The full text of an anchored transcript message (for prompt context), or "". */
function anchoredMessageText(worktree: string, messageKey: number): string {
  for (const m of get(transcripts)[worktree] ?? []) {
    if (m.__key !== messageKey) continue;
    if (m.type === "assistant" || m.type === "user_local") return m.text ?? "";
    return "";
  }
  return "";
}

/** The main-chat conversation UP TO AND INCLUDING the anchored message, as prompt
 *  context for a thread (so the agent has the full thread of the discussion, not a
 *  blank slate). High caps honor "full context" while bounding pathological chats;
 *  `buildCommentPrompt` clamps the total again. Reuses `summarizeConversation`. */
function conversationUpTo(worktree: string, messageKey: number): string {
  const all = (get(transcripts)[worktree] ?? []).concat(bufferedMessages(worktree));
  const idx = all.findIndex((m) => m.__key === messageKey);
  const slice = idx >= 0 ? all.slice(0, idx + 1) : all;
  return summarizeConversation(slice, 1000, 4000);
}

/** Submit one turn of a thread (the ONE submit path). Appends the user's question,
 *  marks the thread pending, assembles the out-of-band prompt (full conversation up
 *  to the anchored message + the anchored message itself + prior thread Q&A + the
 *  new question) and fires the isolated IPC. NEVER touches the main transcript or
 *  session status — threads are out-of-band. The streamed answer arrives via
 *  `comment_reply` (see agentEvents.ts). */
export async function submitCommentTurn(worktree: string, id: string, question: string) {
  const q = question.trim();
  if (!q) return;
  const thread = (get(commentsByWorktree)[worktree] ?? []).find((t) => t.id === id);
  if (!thread) return;
  // Prior turns BEFORE we append the new question (the thread's memory).
  const priorMessages = thread.messages.slice();
  appendCommentMessage(worktree, id, { role: "user", text: q });
  setCommentPending(worktree, id, true);
  try {
    // Full context: the conversation up to the anchored message + that message in
    // full. Inside the try so any assembly failure surfaces as a thread error
    // (clears pending) instead of an unhandled rejection that hangs on "Thinking…".
    const prompt = buildCommentPrompt({
      conversation: conversationUpTo(worktree, thread.messageKey),
      anchoredMessage: anchoredMessageText(worktree, thread.messageKey),
      priorMessages,
      newQuestion: q,
    });
    await api.sendCommentTurn(worktree, id, prompt);
  } catch (e) {
    setCommentError(worktree, id, `failed to send: ${e}`);
  }
}