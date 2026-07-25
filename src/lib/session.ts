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

import { get } from "svelte/store";
import * as api from "./api";
import { formatRebasePrompt, formatSavePrompt } from "./savePrompt";
import {
  type ArchivedWorkspace,
  addArchived,
  addRepo,
  addWorktree,
  bumpGitRefresh,
  clearStatus,
  clearUnread,
  DEFAULT_CHAT_ID,
  ensureDefaultChat,
  focusedChatByWorktree,
  removeArchived,
  removeChat,
  removeScriptRun,
  removeWorktreeFromRepo,
  selectedWorktree,
  selectWorktree,
  sessionStatus,
  setCenterView,
  setChatSessionId,
  setChatStatus,
  setStatus,
  setWorktrees,
  worktreesByRepo,
} from "./stores";
// CIRCULAR-IMPORT CONTRACT: terminal.ts imports handleCliExit from this module
// while we import its key/instance helpers — safe because every cross-module
// access is a call-time function invocation (all hoisted declarations).
import {
  claudeTermKey,
  cliBusy,
  disposeChatTerminal,
  disposeTerminal,
  getTerminal,
  muteCliActivity,
  noteCliInput,
} from "./terminal";
import { toastError, toastMessage, toastSuccess } from "./toast";
import type { Worktree } from "./types";
import { basename } from "./utils";

/** Pick a folder and open it as a repo: validate it's a git repo FIRST (so a
 *  bad pick never persists a junk entry), then add it, cache its worktrees, and
 *  activate the main worktree so the user lands in a live chat. The ONE add-repo
 *  path — the Home CTA and the sidebar's FolderPlus both route through here.
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

/** The repo's archive cleanup script failed — a DECISION, not a dead end:
 *  callers catch this to offer "archive anyway" (re-run with skipHook). */
export class ArchiveHookError extends Error {}

/** Archive a workspace: run the repo's archive script (unless `skipHook`),
 *  kill its processes, remove the worktree DIR (branch kept — Claude Code's
 *  path-keyed session store makes restore resume the chat), record the
 *  archive entry, and raise the Undo toast. The ONE archive path — the
 *  sidebar row and the changes popover's lifecycle button both route through
 *  here; callers own their confirm surfaces (dirty trees, hook failures) and
 *  their local error state. */
export async function archiveWorkspace(repoPath: string, wt: Worktree, skipHook = false) {
  if (!wt.branch)
    throw new Error("a detached-HEAD worktree can't archive (restore needs a branch)");
  let archiveCmd: string | null = null;
  if (!skipHook) {
    try {
      archiveCmd = (await api.getScripts(repoPath)).archive;
    } catch {
      // unreadable settings file — archive proceeds without a hook
    }
  }
  if (archiveCmd) {
    try {
      await api.runScriptBlocking(repoPath, wt.path, "archive");
    } catch (err) {
      throw new ArchiveHookError(String(err));
    }
  }
  await api.stopScript(wt.path);
  disposeTerminal(wt.path);
  await api.removeWorktree(repoPath, wt.path, true);
  clearStatus(wt.path);
  removeScriptRun(wt.path);
  removeWorktreeFromRepo(repoPath, wt.path);
  const entry: ArchivedWorkspace = {
    repoPath,
    repoName: basename(repoPath),
    branch: wt.branch,
    path: wt.path,
    archivedAt: Date.now(),
  };
  addArchived(entry);
  if (get(selectedWorktree) === wt.path) selectWorktree(null);
  // Archiving is lossless (restore revives chat + context) — offer the
  // instant round-trip instead of making the action feel scary.
  toastMessage(`Archived ${wt.branch}`, {
    action: { label: "Undo", onClick: () => void restoreWorkspace(entry).catch(() => {}) },
  });
}

/** The session id the DEFAULT chat's first open should resume: the newest
 *  `.jsonl` in the worktree's Claude session store — the migration path from
 *  the single-session era, before the app stored per-chat ids. undefined when
 *  the worktree has no sessions yet or the scan fails (fresh conversation). */
async function resumeIdFor(worktree: string): Promise<string | undefined> {
  return (await api.latestSessionId(worktree).catch(() => null)) ?? undefined;
}

/** (Re)open one chat's claude-slot PTY (the FOCUSED chat when unspecified).
 *  Idempotent (Rust no-ops while one is alive) — the cell's (re)mount path.
 *  Session identity: the chat's stored id is resumed (the modern CLI's
 *  `--resume` KEEPS the id — `--fork-session` is opt-in); a chat with no id
 *  yet either adopts the newest on-disk session (the default chat's migration
 *  path) or names a brand-new one deterministically via `--session-id`.
 *  Marks the chat `ready` on success: the PTY IS the session; busy/idle then
 *  comes from the PTY's output flow (terminal.ts › noteCliActivity). */
export async function ensureClaudeOpen(worktree: string, chatId?: string): Promise<void> {
  const chats = ensureDefaultChat(worktree);
  const id = chatId ?? get(focusedChatByWorktree)[worktree] ?? DEFAULT_CHAT_ID;
  const chat = chats.find((c) => c.id === id) ?? chats[0];
  if (!chat) return; // unreachable (ensureDefaultChat seeds), but typed honest
  const key = claudeTermKey(worktree, chat.id);
  const inst = getTerminal(key);
  const { rows, cols } = inst.term;
  // The chat's identity: its stored id, the newest-on-disk id (the default
  // chat's migration path), or a fresh uuid. Resume ONLY when the transcript
  // exists — the CLI writes it lazily on the first message, and resuming a
  // transcript-less id errors; re-creating under the SAME `--session-id` is
  // idempotent and keeps the identity.
  const stored =
    chat.sessionId ?? (chat.id === DEFAULT_CHAT_ID ? await resumeIdFor(worktree) : undefined);
  let resumeId: string | undefined;
  let newSessionId: string | undefined;
  if (stored && (await api.sessionExists(worktree, stored).catch(() => false))) resumeId = stored;
  else newSessionId = stored ?? crypto.randomUUID();
  const buf = inst.term.buffer.active;
  const untouched = buf.cursorX === 0 && buf.cursorY === 0;
  const spawned = await api.termOpen(
    worktree,
    rows,
    cols,
    "claude",
    resumeId,
    chat.id,
    newSessionId,
  );
  // Pin the chat's transcript identity once the open sticks — resume keeps
  // the id and a new session was named by us, so this stays the live thread.
  if (spawned) setChatSessionId(worktree, chat.id, resumeId ?? (newSessionId as string));
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
  // Infer, don't assume: an idempotent re-open (worktree switch, pane
  // re-attach, layout change) can land mid-turn — the tracker knows whether
  // output is streaming RIGHT NOW. Writing a blind "ready" here used to
  // freeze the sidebar's busy glyph for the rest of the turn (the tracker
  // announces busy once per burst and won't re-fire).
  setChatStatus(worktree, key, cliBusy(key) ? "busy" : "ready");
}

/** Inject a prompt into the worktree's CLI chat as keystrokes: bracketed paste
 *  (so multi-line text doesn't submit per line — the TUI treats it as one
 *  pasted block), followed by Enter when `submit` (default). `submit: false`
 *  just inserts into the TUI's input for further editing — the compose
 *  popup's "Insert" action. `chatId` targets a SPECIFIC chat (the per-cell
 *  ChatComposer); omitted, it lands in the FOCUSED chat — same target in
 *  both layouts (tabs: the visible one; grid: the cell owning the keyboard). */
export async function sendToCli(
  worktree: string,
  text: string,
  submit = true,
  chatId?: string,
): Promise<void> {
  const id = chatId ?? get(focusedChatByWorktree)[worktree] ?? DEFAULT_CHAT_ID;
  await ensureClaudeOpen(worktree, id);
  const key = claudeTermKey(worktree, id);
  // Injected keystrokes are user input too — their echo must not read as a
  // turn starting (the real turn's output keeps flowing past the echo window).
  noteCliInput(key);
  await api.termWrite(key, `\x1b[200~${text}\x1b[201~${submit ? "\r" : ""}`);
}

// Git agents run INVISIBLY (user call: the chat window is the user's
// workspace; janitorial git work must not pollute it). One in-flight agent
// per worktree; completion surfaces as a toast + a git-glance refresh.
const gitAgentInFlight = new Set<string>();

/** Whether a background git agent currently owns this worktree. */
export function gitAgentBusy(worktree: string): boolean {
  return gitAgentInFlight.has(worktree);
}

/** Fire-and-forget a background git agent (headless `claude -p`, git-only
 *  tools — generate.rs). `label` names the job in the completion toast. */
function runGitAgentBg(worktree: string, prompt: string, label: string) {
  if (gitAgentInFlight.has(worktree)) return;
  gitAgentInFlight.add(worktree);
  void api
    .runGitAgent(worktree, prompt)
    .then((summary) => {
      const line = summary.trim().split("\n").at(-1) ?? "done";
      toastSuccess(`${label}: ${line}`);
    })
    .catch((e) => {
      toastError(`${label} failed: ${String(e)}`);
    })
    .finally(() => {
      gitAgentInFlight.delete(worktree);
      bumpGitRefresh();
    });
}

/** Fleet sync: rebase every worktree of a repo onto the latest default
 *  branch, one button. Deterministic per worktree (worktree_rebase_default;
 *  main itself just pulls); a conflicted rebase escalates to a BACKGROUND
 *  git agent for that worktree. Worktrees whose chat is mid-turn, or whose
 *  git agent is already working, are skipped — never move files under a
 *  running agent. */
export async function syncFleet(
  repoPath: string,
): Promise<{ rebased: number; resolving: number; skipped: number }> {
  const wts = get(worktreesByRepo)[repoPath] ?? [];
  const statuses = get(sessionStatus);
  let rebased = 0;
  let resolving = 0;
  let skipped = 0;
  for (const wt of wts) {
    if (statuses[wt.path] === "busy" || gitAgentInFlight.has(wt.path)) {
      skipped++;
      continue;
    }
    try {
      if (wt.is_main) await api.worktreePull(wt.path);
      else await api.worktreeRebaseDefault(wt.path);
      rebased++;
    } catch (e) {
      resolving++;
      runGitAgentBg(
        wt.path,
        formatRebasePrompt({
          branch: wt.branch ?? "(detached)",
          defaultBranch: "the repo default", // the agent resolves it live
          error: String(e),
        }),
        `sync ${wt.branch ?? basename(wt.path)}`,
      );
    }
  }
  bumpGitRefresh();
  return { rebased, resolving, skipped };
}

/** "Save my work": the deterministic fast path with an AGENT fallback.
 *  Chain: stage everything → commit (AI message, plain fallback) → push
 *  (-u covers unpublished branches); a rejected push retries once through
 *  `git pull --rebase --autostash`. When the chain still dead-ends (real
 *  conflicts, diverged history), the failure is formatted (savePrompt.ts)
 *  and handed to the worktree's OWN chat via submitTurnToChat — the same
 *  Claude the user is already talking to finishes the save, visibly, in
 *  the terminal. Returns which path completed so the UI can say so. */
export async function saveWorktree(worktree: string): Promise<"saved" | "escalated"> {
  const status = await api.worktreeStatus(worktree);
  const dirty = status.files.length > 0;
  const unpushed = !status.has_upstream || status.ahead > 0;
  const done: string[] = [];
  const escalate = (step: string, e: unknown) => {
    runGitAgentBg(
      worktree,
      formatSavePrompt({
        branch: status.branch ?? "(detached)",
        step,
        error: String(e),
        done,
      }),
      `save ${status.branch ?? basename(worktree)}`,
    );
    return "escalated" as const;
  };
  if (dirty) {
    try {
      await api.worktreeStage(worktree, []);
      done.push("staged all changes");
      let msg: string;
      try {
        msg = (await api.generateCommitMessage(worktree)).trim();
      } catch {
        msg = `chore: save work on ${status.branch ?? "worktree"}`;
      }
      await api.worktreeCommit(worktree, msg || `chore: save work`);
      done.push("committed");
    } catch (e) {
      return escalate("stage/commit", e);
    }
  }
  if (dirty || unpushed) {
    try {
      await api.worktreePush(worktree, !status.has_upstream);
      done.push("pushed");
    } catch (pushErr) {
      // The screenshot case: the remote is ahead (fetch-first rejection).
      // One deterministic retry through rebase; conflicts auto-abort and
      // land in the escalation with the REAL error.
      try {
        await api.worktreePull(worktree);
        done.push("pulled --rebase");
        await api.worktreePush(worktree, !status.has_upstream);
        done.push("pushed");
      } catch (e) {
        return escalate(
          done.includes("pulled --rebase") ? "push (after rebase)" : "pull --rebase",
          `push was rejected:\n${String(pushErr)}\n\nthen the retry failed:\n${String(e)}`,
        );
      }
    }
  }
  return "saved";
}

/** Interrupt a chat's RUNNING turn: Escape to its PTY — exactly the
 *  keystroke the TUI maps to "stop here" (the composer's stop button).
 *  Registered as input so the interrupt's own repaint can't read as a new
 *  turn starting. Targets like sendToCli: an explicit chat, else the
 *  focused one. */
export async function interruptChat(worktree: string, chatId?: string): Promise<void> {
  const id = chatId ?? get(focusedChatByWorktree)[worktree] ?? DEFAULT_CHAT_ID;
  const key = claudeTermKey(worktree, id);
  noteCliInput(key);
  await api.termWrite(key, "\u001b"); // ESC — the TUI's interrupt key
}

/** Submit a prompt to the chat via keystroke-injection into the CLI. The one
 *  entry point for features that hand text to the agent from outside the chat
 *  pane (git-panel review comments, "fix failing checks"). Closes the loop:
 *  focus the terminal (the injection is invisible from another tab) and raise
 *  a toast receipt so the action doesn't feel like it vanished. */
export async function submitTurnToChat(worktree: string, text: string): Promise<void> {
  await sendToCli(worktree, text);
  const chatId = get(focusedChatByWorktree)[worktree] ?? DEFAULT_CHAT_ID;
  getTerminal(claudeTermKey(worktree, chatId)).term.focus();
  toastSuccess("Sent to the agent");
}

/** The CLI exited (`/exit`, ctrl-d, or a crash). Wired from terminal.ts's
 *  `exit` routing for claude-slot keys; fire-and-forget (PTY events have no
 *  rejection channel). The terminal IS the chat — just mark the session
 *  stopped. No auto-reopen (a crash-looping CLI would respawn forever); the
 *  next keystroke or worktree re-activation revives it. */
export function handleCliExit(worktree: string, key: string): void {
  setChatStatus(worktree, key, "stopped");
}

/** Close one chat: kill its PTY + xterm and drop it from the list (the
 *  transcript on disk stays — Claude Code owns session history). The ONE
 *  close path — the tab ✕ and the grid cell ✕ both route through here. */
export function closeChat(worktree: string, chatId: string): void {
  disposeChatTerminal(worktree, chatId);
  removeChat(worktree, chatId);
}
