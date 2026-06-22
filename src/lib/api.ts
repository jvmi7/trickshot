// Typed wrapper over the Tauri command surface + agent event stream.
// THIS IS THE PRIMARY HOOK POINT for the UI layer: import from here, don't call
// invoke()/listen() directly in components.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEnvelope, Inbound, Outbound, Worktree } from "./types";

// ---- Repository / worktree commands -------------------------------------

/** Native folder picker. Returns the chosen absolute path, or null if cancelled. */
export const pickDirectory = () => invoke<string | null>("pick_directory");

/** List all worktrees of a git repo (the first entry is the main worktree). */
export const listWorktrees = (repoPath: string) =>
  invoke<Worktree[]>("list_worktrees", { repoPath });

/** Create a new worktree (and branch, if it doesn't exist) off `baseRef` (default HEAD). */
export const createWorktree = (repoPath: string, branch: string, baseRef?: string) =>
  invoke<Worktree>("create_worktree", { repoPath, branch, baseRef: baseRef ?? null });

/** Remove a worktree (does not delete its branch). */
export const removeWorktree = (repoPath: string, worktreePath: string, force = false) =>
  invoke<void>("remove_worktree", { repoPath, worktreePath, force });

// ---- Per-worktree agent sessions ----------------------------------------
// Each worktree runs its own sidecar concurrently, keyed by its path.

/** Start (or no-op if already running) the agent session for a worktree.
 *  Pass `resume` (a prior session id) to restore that session's context. */
export const startSession = (worktree: string, resume?: string) =>
  invoke<void>("start_session", { worktree, resume: resume ?? null });

/** Kill a worktree's agent session. */
export const stopSession = (worktree: string) => invoke<void>("stop_session", { worktree });

const send = (worktree: string, msg: Inbound) =>
  invoke<void>("send_to_session", { worktree, payload: JSON.stringify(msg) });

/** Send a user message to a worktree's agent. */
export const sendUserTurn = (worktree: string, text: string) =>
  send(worktree, { kind: "user_turn", text });

/** Answer a pending tool-permission request (dormant under bypassPermissions). */
export const replyPermission = (
  worktree: string,
  id: string,
  behavior: "allow" | "deny",
  message?: string,
) => send(worktree, { kind: "permission_reply", id, behavior, message });

/** Interrupt a worktree's agent mid-task. */
export const interruptAgent = (worktree: string) => send(worktree, { kind: "interrupt" });

/** Switch the model this worktree's chat uses. The sidecar confirms by
 *  re-emitting a `models` event with the updated `current`. */
export const setModel = (worktree: string, model: string) =>
  send(worktree, { kind: "set_model", model });

/** Ask a session to (re-)emit its `models` event. Used to fetch the catalog
 *  on demand, since the one-shot broadcast at `ready` can race the listener. */
export const requestModels = (worktree: string) =>
  send(worktree, { kind: "get_models" });

// ---- Event stream --------------------------------------------------------

/** Subscribe to agent output across ALL worktrees. `onMessage` fires per parsed
 *  protocol message (tagged with its worktree); `onStatus` fires on session
 *  lifecycle (terminated/error). Returns an unlisten function. */
export async function onAgentEvent(
  onMessage: (worktree: string, evt: Outbound) => void,
  onStatus?: (worktree: string, kind: "terminated" | "error", data: string | null) => void,
): Promise<UnlistenFn> {
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
    } else if (kind === "terminated" || kind === "error") {
      onStatus?.(worktree, kind, data);
    }
  });
}
