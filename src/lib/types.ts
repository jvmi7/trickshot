// Protocol truth for the UI side. The wire unions (`Inbound`/`Outbound`/
// `AgentMessage`/`ModelInfo`) live in `shared/protocol.ts` and are imported by
// BOTH this file and the sidecar (`sidecar/core.ts`) so the two TS mirrors can't
// drift. This file re-exports them and adds the app-only types (`TranscriptMessage`,
// `Worktree`, `Repo`, `AgentEnvelope`). The sidecar writes one JSON object per
// line to stdout; Rust relays each line as a worktree-tagged `agent-event` Tauri
// event; api.ts parses them.

import type { AgentMessage } from "../../shared/protocol";

export type {
  AgentMessage,
  ConnectorInfo,
  ConnectorTool,
  Inbound,
  ModelInfo,
  ModelRating,
  Outbound,
  PermissionMode,
  SlashCommandInfo,
  TurnUsage,
} from "../../shared/protocol";

/** A rendered transcript entry: a provider-neutral `AgentMessage`, or a UI-only
 *  bubble — the optimistic user echo (`user_local`) or an error notice. `__key`
 *  is the stable per-message id assigned on append (see stores.appendMessage). */
export type TranscriptMessage = (
  | AgentMessage
  | { type: "user_local"; text: string; rewindId?: string }
  | { type: "error"; error: string }
) & { __key?: number };

/** A git worktree as reported by the worktree commands. */
export interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
  is_main: boolean;
  locked: boolean;
}

/** A git repository the user has added to the sidebar (persisted). */
export interface Repo {
  path: string;
  name: string;
}

/** One changed path in a worktree (mirrors the Rust `FileStatus`). `index` and
 *  `worktree` are the staged/unstaged sides of `git status`'s XY code. */
export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
}

/** A worktree's working-tree status (mirrors the Rust `WorktreeStatus`). */
export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

/** Envelope for a worktree-tagged agent event on the `agent-event` channel
 *  (mirrors the Rust `AgentEvent` struct in agent.rs). */
export interface AgentEnvelope {
  worktree: string;
  kind: "stdout" | "stderr" | "error" | "terminated";
  data: string | null;
}
