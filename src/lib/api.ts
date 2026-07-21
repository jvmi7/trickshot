// Typed wrapper over the Tauri command surface + the script/terminal event
// streams. THIS IS THE PRIMARY HOOK POINT for the UI layer: import from here,
// don't call invoke()/listen() directly in components.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  GitStatus,
  PrInfo,
  PrText,
  ScriptEnvelope,
  ScriptsConfig,
  TermEnvelope,
  UsageInfo,
  Worktree,
} from "./types";

// ---- Repository / worktree commands -------------------------------------

/** Native folder picker. Returns the chosen absolute path, or null if cancelled. */
export const pickDirectory = () => invoke<string | null>("pick_directory");

/** A repo's favicon as a `data:` URI, or null when the repo has none. A
 *  bounded repo walk: an icon DECLARED by an `index.html`/`app.html`
 *  `<link rel="icon">` wins (the site's actual icon); otherwise it ranks
 *  `favicon.*` / `apple-touch-icon.png` anywhere and `icon.png`/`icon.svg`
 *  inside icon-ish dirs (icons/public/static/assets/app). ≤256KB files only. */
export const repoIcon = (repoPath: string) => invoke<string | null>("repo_icon", { repoPath });

/** The user's home directory — the sidebar Home workspace root (~). */
export const homeDir = () => invoke<string>("home_dir");

/** The subscription usage windows for a provider's account (for Claude: rolling
 *  5-hour + weekly). Rejects when unavailable (not logged in, token expired,
 *  rate limited) or when the provider has no usage probe; callers throttle. */
export const getUsage = (provider?: string) =>
  invoke<UsageInfo>("get_usage", { provider: provider ?? null });

/** Whether a login exists on this machine for a provider's account (local
 *  credential read, no network). false = definitively not signed in; rejects
 *  when the check is ambiguous (callers stay silent rather than false-alarm). */
export const checkAuth = (provider?: string) =>
  invoke<boolean>("check_auth", { provider: provider ?? null });

/** Whether the `claude` CLI resolves on the login shell's PATH (the onboarding
 *  preflight — "is the binary installed?", distinct from checkAuth). */
export const checkCli = () => invoke<boolean>("check_cli");

/** List all worktrees of a git repo (the first entry is the main worktree). */
export const listWorktrees = (repoPath: string) =>
  invoke<Worktree[]>("list_worktrees", { repoPath });

/** Create a new worktree (and branch, if it doesn't exist) off `baseRef` (default HEAD). */
export const createWorktree = (repoPath: string, branch: string, baseRef?: string) =>
  invoke<Worktree>("create_worktree", { repoPath, branch, baseRef: baseRef ?? null });

/** Remove a worktree (does not delete its branch). */
export const removeWorktree = (repoPath: string, worktreePath: string, force = false) =>
  invoke<void>("remove_worktree", { repoPath, worktreePath, force });

// ---- Git review (status / diff / stage / commit / push / merge) ----------

/** Parsed working-tree status (branch, ahead/behind, changed files). */
export const worktreeStatus = (worktreePath: string) =>
  invoke<GitStatus>("worktree_status", { worktreePath });

/** Unified diff of uncommitted changes vs `base` (default HEAD), optionally for
 *  one file. Falls back to an all-addition diff for an untracked file. */
export const worktreeDiff = (worktreePath: string, file?: string, base?: string) =>
  invoke<string>("worktree_diff", { worktreePath, file: file ?? null, base: base ?? null });

/** Stage paths (empty list = stage everything). */
export const worktreeStage = (worktreePath: string, paths: string[] = []) =>
  invoke<void>("worktree_stage", { worktreePath, paths });

/** Unstage paths (empty list = unstage everything). */
export const worktreeUnstage = (worktreePath: string, paths: string[] = []) =>
  invoke<void>("worktree_unstage", { worktreePath, paths });

/** Commit staged changes; returns git's stdout. */
export const worktreeCommit = (worktreePath: string, message: string) =>
  invoke<string>("worktree_commit", { worktreePath, message });

/** Push the current branch (`setUpstream` pushes `-u origin <branch>`;
 *  `force` uses --force-with-lease — overwrite a stale remote, never a fresh one). */
export const worktreePush = (worktreePath: string, setUpstream = false, force = false) =>
  invoke<string>("worktree_push", { worktreePath, setUpstream, force });

/** Merge `branch` into the branch checked out at `repoPath` (the main worktree). */
export const worktreeMerge = (repoPath: string, branch: string) =>
  invoke<string>("worktree_merge", { repoPath, branch });

/** Sync with upstream: `git pull --rebase --autostash`. A conflict aborts the
 *  rebase back to the pre-pull state and rejects. */
export const worktreePull = (worktreePath: string) =>
  invoke<string>("worktree_pull", { worktreePath });

/** Move the current branch's commits onto a new `branch` and rewind the former
 *  branch to its upstream — recovery for commits stuck on a protected branch.
 *  Switches to the new branch; returns its name. */
export const worktreeMoveToBranch = (worktreePath: string, branch: string) =>
  invoke<string>("worktree_move_to_branch", { worktreePath, branch });

// ---- Project scripts (.trickshot/settings.json) ---------------------------

/** A repo's scripts config (setup / named run scripts / archive / run_mode). */
export const getScripts = (repoPath: string) => invoke<ScriptsConfig>("get_scripts", { repoPath });

/** Launch a script BY NAME for a worktree ("setup" / "archive" / a run-script
 *  name). The command string is read from the repo's settings file in Rust —
 *  never passed from here. Output streams via `script-event`s. */
export const runScript = (repoPath: string, worktree: string, name: string) =>
  invoke<void>("run_script", { repoPath, worktree, name });

/** Run a script BY NAME to COMPLETION, returning its stdout — for hooks that
 *  must finish before proceeding (the archive script runs before the worktree
 *  dir is deleted). Rejects with the script's stderr on failure. */
export const runScriptBlocking = (repoPath: string, worktree: string, name: string) =>
  invoke<string>("run_script_blocking", { repoPath, worktree, name });

/** Stop a worktree's running script (no-op if none). */
export const stopScript = (worktree: string) => invoke<void>("stop_script", { worktree });

/** Subscribe to script output across ALL worktrees (`started`/`stdout`/
 *  `stderr`/`exit`, tagged with the worktree). Returns an unlisten function. */
export function onScriptEvent(
  onEvent: (worktree: string, kind: ScriptEnvelope["kind"], data: string | null) => void,
): Promise<UnlistenFn> {
  return listen<ScriptEnvelope>("script-event", (e) => {
    const { worktree, kind, data } = e.payload;
    onEvent(worktree, kind, data);
  });
}

// ---- GitHub PRs (gh CLI — the user's existing `gh auth login`) ------------

/** The current branch's PR + its CI check rollup, or null when no PR exists.
 *  Rejects when `gh` is missing or not authenticated. */
export const prStatus = (worktreePath: string) =>
  invoke<PrInfo | null>("pr_status", { worktreePath });

/** Create a PR for the worktree's current branch (must be pushed first).
 *  Returns the PR URL. Empty `base` uses the repo default. */
export const prCreate = (
  worktreePath: string,
  title: string,
  body: string,
  base?: string,
  draft = false,
) => invoke<string>("pr_create", { worktreePath, title, body, base: base ?? null, draft });

/** Merge the current branch's open PR (`gh pr merge --squash`). Returns gh's
 *  stdout; protections/review requirements reject with gh's stderr. */
export const prMerge = (worktreePath: string) => invoke<string>("pr_merge", { worktreePath });

// ---- AI text generation (one-shot `claude -p`) ----------------------------

/** Generate a commit message from the working diff (staged if any, else vs HEAD).
 *  Rejects when there's nothing to describe or `claude` is unavailable. */
export const generateCommitMessage = (worktreePath: string) =>
  invoke<string>("generate_commit_message", { worktreePath });

/** Generate a branch name (slugged, validate_branch-safe) from the working
 *  diff. Rejects when there's nothing to name. */
export const generateBranchName = (worktreePath: string) =>
  invoke<string>("generate_branch_name", { worktreePath });

/** Generate a PR title + body from the commits over `base` (default: repo
 *  default branch). Rejects when there are no commits to propose. */
export const generatePrText = (worktreePath: string, base?: string) =>
  invoke<PrText>("generate_pr_text", { worktreePath, base: base ?? null });

// ---- Integrated terminal (one PTY per worktree) ---------------------------

/** Open (idempotent) a PTY for the worktree. Default: the user's login shell.
 *  `launch: "claude"` runs the Claude Code CLI instead (optionally resuming
 *  `resumeSessionId`) on a SEPARATE PTY keyed by the claude slot (see
 *  `claudeTermKey` in terminal.ts) — the CLI chat mode. The launch value is a
 *  fixed whitelist name; Rust resolves the actual binary (never a command
 *  string from here). Returns whether a PTY was SPAWNED (false = one was
 *  already alive — a reloaded webview must force a repaint, no fresh TUI
 *  paint is coming). */
export const termOpen = (
  worktree: string,
  rows: number,
  cols: number,
  launch?: "claude",
  resumeSessionId?: string,
) =>
  invoke<boolean>("term_open", {
    worktree,
    rows,
    cols,
    launch: launch ?? null,
    resumeSessionId: resumeSessionId ?? null,
  });

/** Write keystrokes to a worktree's PTY. */
export const termWrite = (worktree: string, data: string) =>
  invoke<void>("term_write", { worktree, data });

/** Resize a worktree's PTY (driven by xterm's fit addon). */
export const termResize = (worktree: string, rows: number, cols: number) =>
  invoke<void>("term_resize", { worktree, rows, cols });

/** Kill a worktree's PTY (no-op if none). */
export const termClose = (worktree: string) => invoke<void>("term_close", { worktree });

/** Subscribe to PTY output across ALL worktrees (`data` chunks + the final
 *  `exit`). Returns an unlisten function. */
export function onTermEvent(
  onEvent: (worktree: string, kind: TermEnvelope["kind"], data: string | null) => void,
): Promise<UnlistenFn> {
  return listen<TermEnvelope>("term-event", (e) => {
    const { worktree, kind, data } = e.payload;
    onEvent(worktree, kind, data);
  });
}

// ---- Agent sessions (Claude Code's own session store) ---------------------

/** The newest Claude Code session id recorded for a worktree (resume forks a
 *  new id, so any remembered id goes stale the moment the CLI runs — this
 *  scan finds the live thread). null when the worktree has no sessions yet.
 *  Provider-gated like getUsage/checkAuth. */
export const latestSessionId = (worktree: string, provider?: string) =>
  invoke<string | null>("latest_session_id", { worktree, provider: provider ?? null });
