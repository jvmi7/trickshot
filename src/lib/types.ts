// Shared protocol types. These mirror the JSON contract spoken by the sidecar
// (see sidecar/core.ts). The sidecar writes one JSON object per line to stdout;
// Rust relays each line as a worktree-tagged `agent-event` Tauri event; api.ts
// parses them.

/** A pass-through Claude Agent SDK message (SDKMessage). Kept loose on purpose —
 *  the UI branches on `type` and reads fields defensively. */
export interface SDKMessageLike {
  type: string;
  /** Stable per-message key assigned on append (see stores.appendMessage). */
  __key?: number;
  [key: string]: unknown;
}

/** A model the current chat can switch to (a trimmed SDK ModelInfo). */
export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
}

/** Messages flowing FROM the sidecar TO the app. */
export type Outbound =
  | { kind: "ready" }
  | { kind: "message"; message: SDKMessageLike }
  | { kind: "permission_request"; id: string; tool: string; input: unknown }
  | { kind: "models"; models: ModelInfo[]; current: string }
  | { kind: "error"; error: string };

/** Messages flowing FROM the app TO the sidecar (sent as a JSON string via the
 *  `send_to_session` Tauri command). */
export type Inbound =
  | { kind: "user_turn"; text: string }
  | { kind: "permission_reply"; id: string; behavior: "allow" | "deny"; message?: string }
  | { kind: "set_model"; model: string }
  | { kind: "get_models" }
  | { kind: "interrupt" };

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
