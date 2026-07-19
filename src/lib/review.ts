// Review-queue plumbing: the comment shape and the ONE place the batched
// review prompt is assembled (minimal.ts precedent — a marker/format gets one
// home). Pure, so the prompt shape is unit-testable; state lives in
// stores.ts › reviewQueueByWorktree and the UI in GitPanel.

/** One queued line comment. `id` is a stable per-app-run key (identity keying,
 *  like QueuedMessage). */
export interface ReviewComment {
  id: number;
  file: string;
  /** The diff line the comment anchors to (with its +/-/space marker). */
  line: string;
  /** The enclosing @@ hunk header, when known. */
  hunk: string | null;
  text: string;
}

/** Assemble the batched review turn: numbered comments with their file/hunk/
 *  line anchors, then one instruction. The single-comment path uses the same
 *  shape (a list of one) so the agent sees ONE consistent format. */
export function formatReviewPrompt(comments: readonly ReviewComment[]): string {
  const items = comments
    .map((c, i) => {
      const hunk = c.hunk ? `\n   Hunk: \`${c.hunk}\`` : "";
      return `${i + 1}. \`${c.file}\`${hunk}\n   Line: \`${c.line}\`\n\n   ${c.text}`;
    })
    .join("\n\n");
  const plural = comments.length === 1 ? "this review comment" : "these review comments";
  return `Review comments on the current changes:\n\n${items}\n\nPlease address ${plural} in the code.`;
}
