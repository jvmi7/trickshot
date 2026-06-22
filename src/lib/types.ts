// Protocol truth for the UI side. The wire unions (`Inbound`/`Outbound`/
// `ModelInfo`) live in `shared/protocol.ts` and are imported by BOTH this file
// and the sidecar (`sidecar/core.ts`) so the two TS mirrors can't drift. This
// file binds `Outbound`'s message to the loose `SDKMessageLike` and adds the
// app-only types (`Worktree`, `Repo`, `AgentEnvelope`). The sidecar writes one
// JSON object per line to stdout; Rust relays each line as a worktree-tagged
// `agent-event` Tauri event; api.ts parses them.

import type { Outbound as OutboundOf } from "../../shared/protocol";

export type { Inbound, ModelInfo } from "../../shared/protocol";

/** A pass-through Claude Agent SDK message (SDKMessage). Kept loose on purpose —
 *  the UI branches on `type` and reads fields defensively. */
export interface SDKMessageLike {
  type: string;
  /** Stable per-message key assigned on append (see stores.appendMessage). */
  __key?: number;
  [key: string]: unknown;
}

/** Messages flowing FROM the sidecar TO the app (loose message representation). */
export type Outbound = OutboundOf<SDKMessageLike>;

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

/** Envelope for a worktree-tagged agent event on the `agent-event` channel
 *  (mirrors the Rust `AgentEvent` struct in agent.rs). */
export interface AgentEnvelope {
  worktree: string;
  kind: "stdout" | "stderr" | "error" | "terminated";
  data: string | null;
}
