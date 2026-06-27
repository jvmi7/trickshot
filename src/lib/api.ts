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
  UsageInfo,
  Worktree,
} from "./types";

// ---- Repository / worktree commands -------------------------------------

/** Native folder picker. Returns the chosen absolute path, or null if cancelled. */
export const pickDirectory = () => invoke<string | null>("pick_directory");

/** Show a desktop (OS) notification. */
export const notify = (title: string, body: string) => invoke<void>("notify", { title, body });

/** The Claude subscription usage windows (rolling 5-hour + weekly). Rejects when
 *  unavailable (not logged in, token expired, rate limited); callers throttle. */
export const getUsage = () => invoke<UsageInfo>("get_usage");

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

/** Push the current branch (`setUpstream` pushes `-u origin <branch>`). */
export const worktreePush = (worktreePath: string, setUpstream = false) =>
  invoke<string>("worktree_push", { worktreePath, setUpstream });

/** Merge `branch` into the branch checked out at `repoPath` (the main worktree). */
export const worktreeMerge = (repoPath: string, branch: string) =>
  invoke<string>("worktree_merge", { repoPath, branch });

// ---- Per-worktree agent sessions ----------------------------------------
// Each worktree runs its own sidecar concurrently, keyed by its path.

/** Start (or no-op if already running) the agent session for a worktree.
 *  Options: `resume` (a prior session id) restores that session's context;
 *  `permissionMode` sets the initial tool-permission gate (default
 *  bypassPermissions; a non-bypass value activates the Allow/Deny modal);
 *  `systemPromptAppend` adds custom text to the preset system prompt; `provider`
 *  picks a model-provider adapter (default "claude"). */
export const startSession = (
  worktree: string,
  opts: {
    resume?: string;
    permissionMode?: PermissionMode;
    systemPromptAppend?: string;
    mcpServers?: Record<string, unknown>;
    agents?: Record<string, unknown>;
    provider?: string;
  } = {},
) =>
  invoke<void>("start_session", {
    worktree,
    resume: opts.resume ?? null,
    permissionMode: opts.permissionMode ?? null,
    systemPromptAppend: opts.systemPromptAppend ?? null,
    mcpServers: opts.mcpServers ? JSON.stringify(opts.mcpServers) : null,
    agents: opts.agents ? JSON.stringify(opts.agents) : null,
    provider: opts.provider ?? null,
  });

/** Kill a worktree's agent session. */
export const stopSession = (worktree: string) => invoke<void>("stop_session", { worktree });

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
