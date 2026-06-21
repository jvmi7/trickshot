// Shared protocol types. These mirror the JSON contract spoken by the sidecar
// (see sidecar/core.ts). The sidecar writes one JSON object per line to stdout;
// Rust relays each line as an `agent-stdout` Tauri event; api.ts parses them.

/** A pass-through Claude Agent SDK message (SDKMessage). Kept loose on purpose —
 *  the UI branches on `type` and reads fields defensively. */
export interface SDKMessageLike {
  type: string;
  [key: string]: unknown;
}

/** Messages flowing FROM the sidecar TO the app. */
export type Outbound =
  | { kind: "ready" }
  | { kind: "message"; message: SDKMessageLike }
  | { kind: "permission_request"; id: string; tool: string; input: unknown }
  | { kind: "error"; error: string };

/** Messages flowing FROM the app TO the sidecar (sent as a JSON string via
 *  the `send_to_agent` Tauri command). */
export type Inbound =
  | { kind: "user_turn"; text: string }
  | { kind: "permission_reply"; id: string; behavior: "allow" | "deny"; message?: string }
  | { kind: "interrupt" };

/** A git worktree as reported by the `list_worktrees` / `create_worktree` commands. */
export interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
  is_main: boolean;
  locked: boolean;
}
