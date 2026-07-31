// The Save escalation prompt — what the worktree's OWN chat agent receives
// when the deterministic save chain (stage → commit → push, pull-rebase
// retry) dead-ends. Pure and tested (the review.ts formatter precedent):
// the prompt must carry exactly what failed, keep the agent inside git, and
// forbid the moves that lose work.

export interface SaveFailure {
  /** The branch being saved (display + push target). */
  branch: string;
  /** Which step of the chain failed ("push", "pull --rebase", …). */
  step: string;
  /** The raw error (git stderr) — truncated here so a huge hint dump can't
   *  blow up the prompt. */
  error: string;
  /** Steps that already SUCCEEDED, in order (so the agent doesn't redo them). */
  done: string[];
}

const MAX_ERROR_CHARS = 2000;

/** Build the hand-off prompt for the chat agent. */
export function formatSavePrompt(f: SaveFailure): string {
  const err =
    f.error.length > MAX_ERROR_CHARS
      ? `${f.error.slice(0, MAX_ERROR_CHARS)}\n[truncated]`
      : f.error;
  const done = f.done.length > 0 ? f.done.join(", ") : "nothing yet";
  return [
    `The app's Save action hit a wall in this worktree — please take over and finish saving my work.`,
    ``,
    `Goal: every local change committed and pushed to origin/${f.branch}.`,
    `Already done by the app: ${done}.`,
    `Failed at: ${f.step}`,
    "```",
    err,
    "```",
    ``,
    `Guardrails:`,
    `- Use git only, and only in this worktree.`,
    `- Never discard my changes; prefer rebase over merge for integrating the remote.`,
    `- No force-push. If a rebase YOU performed requires it, use --force-with-lease and say so.`,
    `- If resolving a conflict needs product judgment, stop and ask me instead of guessing.`,
    ``,
    `When done, reply with a one-line summary of what you did.`,
  ].join("\n");
}

export interface RebaseFailure {
  /** The worktree's branch being rebased. */
  branch: string;
  /** The repo default branch it must land on. */
  defaultBranch: string;
  /** The aborted rebase's error (git stderr), truncated like save errors. */
  error: string;
}

/** Build the fleet-sync hand-off: the background agent re-runs the rebase
 *  and resolves what the deterministic pass aborted on. */
export function formatRebasePrompt(f: RebaseFailure): string {
  const err =
    f.error.length > MAX_ERROR_CHARS
      ? `${f.error.slice(0, MAX_ERROR_CHARS)}\n[truncated]`
      : f.error;
  return [
    `Rebase this worktree's branch (${f.branch}) onto origin/${f.defaultBranch}.`,
    `The app already tried \`git rebase --autostash origin/${f.defaultBranch}\`; it hit conflicts and was aborted:`,
    "```",
    err,
    "```",
    ``,
    `Guardrails:`,
    `- Use git only, and only in this worktree.`,
    `- Re-run the rebase and resolve the conflicts faithfully — keep BOTH sides' intent; never discard my changes to make a conflict go away.`,
    `- No force-push unless the branch was already published and the rebase you performed requires it — then --force-with-lease only.`,
    `- If a conflict needs product judgment you don't have, abort the rebase (leave the worktree clean) and say so.`,
    ``,
    `When done, reply with a one-line summary.`,
  ].join("\n");
}
