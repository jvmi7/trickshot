// Single source of truth for the line-delimited JSON protocol between the app
// and the sidecar. Imported by BOTH ends (webview via `src/lib/types.ts`, the
// Bun sidecar via `sidecar/core.ts`) so the two TS mirrors can't drift.
//
// Provider-neutral by design: nothing here is Claude-specific. The sidecar runs
// a pluggable provider adapter (see `sidecar/providers/`) that maps its native
// agent events into the neutral `AgentMessage` schema below, so the UI renders
// ONE shape regardless of which model provider is behind it. Adding a provider
// is a new adapter, not a protocol change.
//
// The Rust relay (`src-tauri/src/agent.rs`) and `ARCHITECTURE.md` still mirror
// this by hand — there is no compiler link to Rust. See the SYNC RULE in
// CLAUDE.md: changing a `kind`/payload here means editing those two as well, in
// the same commit.

/** A model the current chat can switch to. `meta` is provider-supplied
 *  comparison data (the UI renders it generically; it does NOT infer tiers). */
export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
  /** Optional comparison axes, each a 0..max score. Rendered as pips by the
   *  model selector in declared order; omit for providers that don't rank. */
  meta?: ModelRating[];
}
export interface ModelRating {
  label: string;
  score: number;
  /** Pip count (default 4). */
  max?: number;
}

/** A tool exposed by an MCP connector (server). `readOnly`/`destructive` mirror
 *  the provider's tool annotations so the UI can flag what a tool can do. */
export interface ConnectorTool {
  name: string;
  description?: string;
  readOnly?: boolean;
  destructive?: boolean;
}

/** An MCP connector (server) available to the current session, with its live
 *  connection status and the tools it exposes. Provider-neutral: a provider maps
 *  its native server status into this. `status` follows the common MCP lifecycle;
 *  a connector the user has turned off reports `disabled`. */
export interface ConnectorInfo {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  /** Where the connector is configured (e.g. project | user | local | managed). */
  scope?: string;
  /** Failure detail when `status` is `failed`. */
  error?: string;
  tools: ConnectorTool[];
}

/** A slash command the current session offers (provider-supplied). */
export interface SlashCommandInfo {
  name: string;
  description: string;
}

/** Connection status of one configured MCP server. */
export interface McpStatusInfo {
  name: string;
  status: string;
}

/** Token + cost figures for one completed turn, mapped from the provider's
 *  end-of-turn result. All optional: a provider that doesn't report a field
 *  omits it, and the UI renders nothing for a missing field (never throws).
 *  `costUsd` is a client-side estimate, not authoritative billing. */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
}

/** Provider-neutral transcript event. Every provider adapter maps its native
 *  output into these; the UI renders ONLY these (never provider-specific
 *  shapes). One message per semantic event: assistant prose, a tool call, a
 *  tool result, a session notice, or the end-of-turn marker (which also carries
 *  optional token/cost usage for the turn). */
// `parentId` (when set) is the id of the `Agent` tool call that spawned a
// subagent — present on messages a subagent produced, so the UI can nest them.
export type AgentMessage =
  | { type: "system"; text: string }
  | { type: "assistant"; text: string; parentId?: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; parentId?: string }
  | { type: "tool_result"; id: string; content: string; isError?: boolean; parentId?: string }
  | { type: "turn_end"; usage?: TurnUsage };

/** Messages flowing FROM the app TO the sidecar (sent as a JSON string via the
 *  `send_to_session` Tauri command). Provider-agnostic. */
export type Inbound =
  | { kind: "user_turn"; text: string }
  | { kind: "permission_reply"; id: string; behavior: "allow" | "deny"; message?: string }
  | { kind: "set_model"; model: string }
  | { kind: "set_permission_mode"; mode: PermissionMode }
  | { kind: "get_models" }
  | { kind: "get_connectors" }
  | { kind: "toggle_connector"; name: string; enabled: boolean }
  | { kind: "reconnect_connector"; name: string }
  | { kind: "get_commands" }
  | { kind: "interrupt" }
  | { kind: "rewind"; messageId: string }
  // Provider-specific MCP server config (opaque blob, e.g. `.mcp.json`'s
  // `mcpServers`). Applied live; `get_mcp_status` requests a status refresh.
  | { kind: "set_mcp_servers"; servers: Record<string, unknown> }
  | { kind: "get_mcp_status" };

/** Provider-neutral permission modes (mirrors the Claude SDK's `PermissionMode`).
 *  `bypassPermissions` runs every tool without prompting (the historical
 *  default); the others route tool use through `canUseTool` → a
 *  `permission_request` the UI answers with `permission_reply`. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Messages flowing FROM the sidecar TO the app. `message` carries the neutral
 *  `AgentMessage`; `session` reports the (provider-specific) resumable session
 *  id once known. */
export type Outbound =
  | { kind: "ready" }
  | { kind: "session"; id: string }
  | { kind: "message"; message: AgentMessage }
  | { kind: "permission_request"; id: string; tool: string; input: unknown }
  | { kind: "models"; models: ModelInfo[]; current: string }
  | { kind: "connectors"; servers: ConnectorInfo[] }
  | { kind: "error"; error: string }
  // The provider-assigned id of a user turn, usable as a `rewind` target (file
  // checkpoint). Emitted once the agent backend echoes the turn with its id.
  | { kind: "checkpoint"; id: string }
  // The session's available slash commands (on ready and after get_commands).
  | { kind: "commands"; commands: SlashCommandInfo[] }
  // MCP server connection statuses (on ready and after get_mcp_status / set_mcp_servers).
  | { kind: "mcp_status"; servers: McpStatusInfo[] }
  // The agent wants attention (e.g. needs input). The app may raise an OS
  // notification, especially for a backgrounded (non-selected) worktree.
  | { kind: "notification"; message: string; notificationType?: string };
