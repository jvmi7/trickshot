// Typed wrapper over the Tauri command surface + agent event stream.
// THIS IS THE PRIMARY HOOK POINT for the UI layer: import from here, don't call
// invoke()/listen() directly in components.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEnvelope,
  GitStatus,
  Inbound,
  Outbound,
  PermissionMode,
  PrInfo,
  ScriptEnvelope,
  ScriptsConfig,
  SessionConfig,
  TermEnvelope,
  UsageInfo,
  Worktree,
} from "./types";

// ---- Repository / worktree commands -------------------------------------

/** Native folder picker. Returns the chosen absolute path, or null if cancelled. */
export const pickDirectory = () => invoke<string | null>("pick_directory");

/** Show a desktop (OS) notification. */
export const notify = (title: string, body: string) => invoke<void>("notify", { title, body });

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

// ---- Integrated terminal (one PTY per worktree) ---------------------------

/** Open (idempotent) a PTY for the worktree. Default: the user's login shell.
 *  `launch: "claude"` runs the Claude Code CLI instead (optionally resuming
 *  `resumeSessionId`) on a SEPARATE PTY keyed by the claude slot (see
 *  `claudeTermKey` in terminal.ts) — the CLI chat mode. The launch value is a
 *  fixed whitelist name; Rust resolves the actual binary (never a command
 *  string from here). */
export const termOpen = (
  worktree: string,
  rows: number,
  cols: number,
  launch?: "claude",
  resumeSessionId?: string,
) =>
  invoke<void>("term_open", {
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

// ---- Per-worktree agent sessions ----------------------------------------
// Each worktree runs its own sidecar concurrently, keyed by its path.

/** Start (or no-op if already running) the agent session for a worktree. The
 *  whole start-up config rides in one JSON blob (`SessionConfig`): `resumeSessionId`
 *  restores a prior session's context, `permissionMode` sets the initial
 *  tool-permission gate (default bypassPermissions; a non-bypass value activates
 *  the Allow/Deny modal), `systemPromptAppend` adds custom prompt text, `provider`
 *  picks a model-provider adapter (default "claude"). Rust forwards the blob
 *  opaquely; the sidecar parses it once (see SessionConfig). */
export const startSession = (worktree: string, config: SessionConfig = {}) =>
  invoke<void>("start_session", { worktree, config: JSON.stringify(config) });

/** Kill a worktree's agent session. */
export const stopSession = (worktree: string) => invoke<void>("stop_session", { worktree });

/** The newest Claude Code session id recorded for a worktree (resume forks a
 *  new id, so after a CLI chat-mode stint the persisted id is stale — this
 *  scan finds the live thread). null when the worktree has no sessions yet.
 *  Provider-gated like getUsage/checkAuth. */
export const latestSessionId = (worktree: string, provider?: string) =>
  invoke<string | null>("latest_session_id", { worktree, provider: provider ?? null });

const send = (worktree: string, msg: Inbound) =>
  invoke<void>("send_to_session", { worktree, payload: JSON.stringify(msg) });

/** Send a user message to a worktree's agent. */
export const sendUserTurn = (worktree: string, text: string) =>
  send(worktree, { kind: "user_turn", text });

/** Answer a pending tool-permission request (active only when a non-bypass
 *  permissionMode is set on the session — see startSession). */
export const replyPermission = (
  worktree: string,
  id: string,
  behavior: "allow" | "deny",
  message?: string,
) => send(worktree, { kind: "permission_reply", id, behavior, message });

/** Answer a pending question (the agent's `ask_user`) with the user's choices —
 *  per question, the chosen option labels (one for single-select, more for multi). */
export const replyQuestion = (worktree: string, id: string, answers: string[][]) =>
  send(worktree, { kind: "question_reply", id, answers });

/** Interrupt a worktree's agent mid-task. */
export const interruptAgent = (worktree: string) => send(worktree, { kind: "interrupt" });

/** Ask the agent to generate suggested next replies for the recent conversation.
 *  Answered async via a `suggestions` event on the agent stream. */
export const requestSuggestions = (worktree: string, conversation: string) =>
  send(worktree, { kind: "suggest", conversation });

/** Run an OUT-OF-BAND agent turn for an inline comment thread. `prompt` is the
 *  app-assembled thread context; the answer streams back via `comment_reply`
 *  events tagged with `id`. Never touches the main session/transcript. */
export const sendCommentTurn = (worktree: string, id: string, prompt: string) =>
  send(worktree, { kind: "comment_turn", id, prompt });

/** Abort an in-flight comment answer for thread `id` (popup close / supersede). */
export const cancelComment = (worktree: string, id: string) =>
  send(worktree, { kind: "comment_cancel", id });

/** Switch the model this worktree's chat uses. The sidecar confirms by
 *  re-emitting a `models` event with the updated `current`. */
export const setModel = (worktree: string, model: string) =>
  send(worktree, { kind: "set_model", model });

/** Ask a session to (re-)emit its `models` event. Used to fetch the catalog
 *  on demand, since the one-shot broadcast at `ready` can race the listener. */
export const requestModels = (worktree: string) => send(worktree, { kind: "get_models" });

/** Ask a session to (re-)emit its `connectors` event (MCP servers + tools).
 *  Resilient fetch, mirroring requestModels — the ready-time broadcast can race. */
export const requestConnectors = (worktree: string) => send(worktree, { kind: "get_connectors" });

/** Enable or disable an MCP connector for a worktree's live session. The sidecar
 *  confirms by re-emitting a `connectors` event with the updated status. */
export const toggleConnector = (worktree: string, name: string, enabled: boolean) =>
  send(worktree, { kind: "toggle_connector", name, enabled });

/** Reconnect an MCP connector (e.g. after a failure / needs-auth). */
export const reconnectConnector = (worktree: string, name: string) =>
  send(worktree, { kind: "reconnect_connector", name });

/** Ask a session to (re-)emit its `commands` event (available slash commands). */
export const requestCommands = (worktree: string) => send(worktree, { kind: "get_commands" });

/** Replace a session's live MCP server set (an opaque provider config blob). */
export const setMcpServers = (worktree: string, servers: Record<string, unknown>) =>
  send(worktree, { kind: "set_mcp_servers", servers });

/** Switch a worktree's tool-permission mode live (mid-session). */
export const setPermissionMode = (worktree: string, mode: PermissionMode) =>
  send(worktree, { kind: "set_permission_mode", mode });

// ---- Event stream --------------------------------------------------------

/** Subscribe to agent output across ALL worktrees. `onMessage` fires per parsed
 *  protocol message (tagged with its worktree); `onStatus` fires on session
 *  lifecycle (terminated/error). Returns an unlisten function. */
export async function onAgentEvent(
  onMessage: (worktree: string, evt: Outbound) => void,
  onStatus?: (worktree: string, kind: "terminated" | "error", data: string | null) => void,
): Promise<UnlistenFn> {
  // Keep a bounded tail of each session's stderr. Sidecar/native-CLI stderr is
  // otherwise dropped entirely, so a session that dies WITHOUT emitting a JSON
  // error (e.g. the Bun process or claude binary crashes) would surface only a
  // bare exit code. We attach this tail to the death so there's a diagnostic.
  const STDERR_TAIL = 40;
  const stderrTail = new Map<string, string[]>();

  return listen<AgentEnvelope>("agent-event", (e) => {
    const { worktree, kind, data } = e.payload;
    if (kind === "stdout" && data) {
      for (const line of data.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onMessage(worktree, JSON.parse(trimmed) as Outbound);
        } catch {
          // ignore non-JSON noise on stdout
        }
      }
    } else if (kind === "stderr" && data) {
      const buf = stderrTail.get(worktree) ?? [];
      for (const line of data.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) buf.push(trimmed);
      }
      if (buf.length > STDERR_TAIL) buf.splice(0, buf.length - STDERR_TAIL);
      stderrTail.set(worktree, buf);
    } else if (kind === "terminated" || kind === "error") {
      const tail = stderrTail.get(worktree)?.join("\n") ?? "";
      stderrTail.delete(worktree);
      if (kind === "error") {
        onStatus?.(worktree, "error", [data, tail].filter(Boolean).join("\n") || data);
      } else {
        // Surface a bubble only when the sidecar actually wrote stderr (which is
        // otherwise dropped). A bare non-zero exit code is NOT surfaced: a fatal
        // agent-loop exit already showed the cause via an in-band `error`, and a
        // normal kill (stop_session) exits clean. onStatus still fires either way
        // so the session is reset to `stopped`.
        const detail = tail ? `sidecar exited (code ${data ?? "?"})\n${tail}` : null;
        onStatus?.(worktree, "terminated", detail);
      }
    }
  });
}
