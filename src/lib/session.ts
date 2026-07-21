// Session/turn orchestration — the async flows split out of stores.ts by the
// scriptEvents.ts precedent: opening a repo, activating a worktree's CLI chat,
// and handing prompts to the Claude Code TUI. stores.ts re-exports everything
// so `import { activateWorktree } from "./stores"` keeps working.
//
// CIRCULAR-IMPORT CONTRACT: this module and stores.ts import each other, which
// is safe under ESM live bindings ONLY as long as the sibling touches
// stores.ts's state lazily — every cross-module access here is a call-time
// function invocation (all hoisted declarations), never a module-eval
// dereference. Keep it that way.

import * as api from "./api";
import {
  type ArchivedWorkspace,
  addRepo,
  addWorktree,
  clearUnread,
  removeArchived,
  selectWorktree,
  setCenterView,
  setStatus,
  setWorktrees,
} from "./stores";
// CIRCULAR-IMPORT CONTRACT: terminal.ts imports handleCliExit from this module
// while we import its key/instance helpers — safe because every cross-module
// access is a call-time function invocation (all hoisted declarations).
import { claudeTermKey, getTerminal, muteCliActivity, noteCliInput } from "./terminal";
import { toastSuccess } from "./toast";
import { basename } from "./utils";

/** Pick a folder and open it as a repo: validate it's a git repo FIRST (so a
 *  bad pick never persists a junk entry), then add it, cache its worktrees, and
 *  activate the main worktree so the user lands in a live chat. The ONE add-repo
 *  path — the Welcome CTA and the sidebar's FolderPlus both route through here.
 *  Returns false when the picker is cancelled; throws on failure so callers
 *  surface it in their local error state. */
export async function openRepository(): Promise<boolean> {
  const p = await api.pickDirectory();
  if (!p) return false;
  const wts = await api.listWorktrees(p); // validate before persisting
  // A bare entry has no working files, so it can't host an agent session. Land
  // on the first non-bare worktree; a repo with ONLY bare entries is rejected
  // before anything persists.
  const usable = wts.filter((w) => !w.is_bare);
  if (usable.length === 0) {
    throw new Error("that's a bare repository — pick a working checkout");
  }
  addRepo({ path: p, name: basename(p) });
  setWorktrees(p, wts);
  const main = usable.find((w) => w.is_main) ?? usable[0];
  if (main) await activateWorktree(main.path);
  return true;
}

/** Activate a worktree: select it, return the center pane to the chat, clear
 *  its unread badge, and (re)open its CLI session. The ONE activation path —
 *  the sidebar row and the command palette both route through here. Throws on
 *  a spawn failure so callers surface it in their local error state. */
export async function activateWorktree(path: string) {
  selectWorktree(path);
  setCenterView("chat");
  clearUnread(path);
  // The claude PTY IS this worktree's session. ClaudeTerminalPane's mount
  // opens it; re-activating an exited CLI revives it here (idempotent when
  // already alive).
  await ensureClaudeOpen(path).catch((e) => {
    setStatus(path, "stopped");
    throw e;
  });
}

/** Restore an archived workspace: recreate the worktree from its branch (the
 *  deterministic path revives the persisted session store, so the CLI resumes
 *  the same conversation), re-add the repo if it was removed meanwhile
 *  (addRepo dedupes), drop the archive entry, and activate it. The ONE restore
 *  path — the sidebar's Archived list and the command palette both route
 *  through here. Throws for the caller's error surface. */
export async function restoreWorkspace(entry: ArchivedWorkspace): Promise<void> {
  const wt = await api.createWorktree(entry.repoPath, entry.branch);
  addRepo({ path: entry.repoPath, name: entry.repoName });
  addWorktree(entry.repoPath, wt);
  removeArchived(entry.repoPath, entry.branch);
  await activateWorktree(wt.path);
}

/** The session id the next open should resume: the newest `.jsonl` in the
 *  worktree's Claude session store (resume FORKS a new id, so any remembered
 *  id goes stale the moment the CLI runs — the disk scan finds the live
 *  thread). undefined when the worktree has no sessions yet or the scan fails
 *  (the CLI then starts a fresh conversation). */
async function resumeIdFor(worktree: string): Promise<string | undefined> {
  return (await api.latestSessionId(worktree).catch(() => null)) ?? undefined;
}

/** (Re)open the claude-slot PTY for a worktree, resuming the live session id.
 *  Idempotent (Rust no-ops while one is alive) — the pane's (re)mount path.
 *  Marks the session `ready` on success: the PTY IS the session; busy/idle
 *  then comes from the PTY's output flow (terminal.ts › noteCliActivity). */
export async function ensureClaudeOpen(worktree: string): Promise<void> {
  const key = claudeTermKey(worktree);
  const inst = getTerminal(key);
  const { rows, cols } = inst.term;
  const resumeId = await resumeIdFor(worktree);
  const buf = inst.term.buffer.active;
  const untouched = buf.cursorX === 0 && buf.cursorY === 0;
  const spawned = await api.termOpen(worktree, rows, cols, "claude", resumeId);
  // Neither of the bursts below is a turn — don't let them light the busy
  // indicator: a fresh spawn streams the TUI's boot/resume paint for seconds;
  // the reload wiggle triggers a full repaint (see cliActivity.ts).
  if (spawned) muteCliActivity(key, 5000);
  else if (untouched) muteCliActivity(key, 1500);
  if (spawned && resumeId && untouched) {
    // Cold spawn + a session to resume: the TUI does NOT repaint earlier
    // turns, so a fresh terminal would read as a blank "new" chat while the
    // agent's context is intact. Say so once. (Written just after the open —
    // the TUI's first output trails the process boot by far more.)
    inst.term.write(
      "\x1b[2m↻ resuming previous session — earlier turns aren't shown here; the agent's context is intact\x1b[0m\r\n",
    );
  } else if (!spawned && untouched) {
    // The PTY survived a webview reload: this xterm is empty and the live TUI
    // has no reason to repaint — blank pane. A resize wiggle (SIGWINCH twice)
    // makes the TUI redraw its full frame into the fresh buffer.
    await api.termResize(key, rows, Math.max(2, cols - 1)).catch(() => {});
    await api.termResize(key, rows, cols).catch(() => {});
  }
  inst.open = true;
  setStatus(worktree, "ready");
}

/** Inject a prompt into the worktree's CLI chat as keystrokes: bracketed paste
 *  (so multi-line text doesn't submit per line — the TUI treats it as one
 *  pasted block), followed by Enter when `submit` (default). `submit: false`
 *  just inserts into the TUI's input for further editing — the compose
 *  popup's "Insert" action. */
export async function sendToCli(worktree: string, text: string, submit = true): Promise<void> {
  await ensureClaudeOpen(worktree);
  // Injected keystrokes are user input too — their echo must not read as a
  // turn starting (the real turn's output keeps flowing past the echo window).
  noteCliInput(claudeTermKey(worktree));
  await api.termWrite(claudeTermKey(worktree), `\x1b[200~${text}\x1b[201~${submit ? "\r" : ""}`);
}

/** Submit a prompt to the chat via keystroke-injection into the CLI. The one
 *  entry point for features that hand text to the agent from outside the chat
 *  pane (git-panel review comments, "fix failing checks"). Closes the loop:
 *  focus the terminal (the injection is invisible from another tab) and raise
 *  a toast receipt so the action doesn't feel like it vanished. */
export async function submitTurnToChat(worktree: string, text: string): Promise<void> {
  await sendToCli(worktree, text);
  getTerminal(claudeTermKey(worktree)).term.focus();
  toastSuccess("Sent to the agent");
}

/** The CLI exited (`/exit`, ctrl-d, or a crash). Wired from terminal.ts's
 *  `exit` routing for claude-slot keys; fire-and-forget (PTY events have no
 *  rejection channel). The terminal IS the chat — just mark the session
 *  stopped. No auto-reopen (a crash-looping CLI would respawn forever); the
 *  next keystroke or worktree re-activation revives it. */
export function handleCliExit(worktree: string): void {
  setStatus(worktree, "stopped");
}
