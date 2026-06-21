// Typed wrapper over the Tauri command surface + agent event stream.
// THIS IS THE PRIMARY HOOK POINT for the UI layer: import from here, don't call
// invoke()/listen() directly in components.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Inbound, Outbound, Worktree } from "./types";

// ---- Repository / worktree commands -------------------------------------

/** Native folder picker. Returns the chosen absolute path, or null if cancelled. */
export const pickDirectory = () => invoke<string | null>("pick_directory");

/** List all worktrees of a git repo (the first entry is the main worktree). */
export const listWorktrees = (repoPath: string) =>
  invoke<Worktree[]>("list_worktrees", { repoPath });

/** Create a new worktree (and branch, if it doesn't exist) off `baseRef` (default HEAD).
 *  Returns the created worktree. This is the "one-click new worktree" primitive. */
export const createWorktree = (repoPath: string, branch: string, baseRef?: string) =>
  invoke<Worktree>("create_worktree", { repoPath, branch, baseRef: baseRef ?? null });

/** Remove a worktree (does not delete its branch). */
export const removeWorktree = (repoPath: string, worktreePath: string, force = false) =>
  invoke<void>("remove_worktree", { repoPath, worktreePath, force });

// ---- Agent session commands ---------------------------------------------

/** Spawn the sidecar with cwd = `projectDir` (a repo or worktree path). Replaces
 *  any running session. */
export const startAgent = (projectDir: string) =>
  invoke<void>("start_agent", { projectDir });

/** Kill the current sidecar process. */
export const stopAgent = () => invoke<void>("stop_agent");

const send = (msg: Inbound) => invoke<void>("send_to_agent", { payload: JSON.stringify(msg) });

/** Send a user message to the agent. */
export const sendUserTurn = (text: string) => send({ kind: "user_turn", text });

/** Answer a pending tool-permission request. */
export const replyPermission = (id: string, behavior: "allow" | "deny", message?: string) =>
  send({ kind: "permission_reply", id, behavior, message });

/** Interrupt the agent mid-task. */
export const interruptAgent = () => send({ kind: "interrupt" });

// ---- Event stream --------------------------------------------------------

/** Subscribe to agent output. The callback receives one parsed `Outbound` per
 *  line. Returns an unlisten function. */
export async function onAgentEvent(cb: (e: Outbound) => void): Promise<UnlistenFn> {
  return listen<string>("agent-stdout", (ev) => {
    for (const line of ev.payload.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        cb(JSON.parse(trimmed) as Outbound);
      } catch {
        // ignore non-JSON noise on stdout
      }
    }
  });
}

/** Subscribe to raw stderr / lifecycle diagnostics (optional). */
export async function onAgentDiagnostic(
  cb: (kind: "stderr" | "error" | "terminated", data: unknown) => void,
): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<string>("agent-stderr", (e) => cb("stderr", e.payload)),
    listen<string>("agent-error", (e) => cb("error", e.payload)),
    listen<number | null>("agent-terminated", (e) => cb("terminated", e.payload)),
  ]);
}
