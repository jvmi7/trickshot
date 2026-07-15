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

/** One selectable choice in a {@link Question}. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** A structured question the agent asks the user, mapped from the provider's
 *  native "ask the user" mechanism (for Claude: the `ask_user` tool). Neutral on
 *  the wire so ANY provider can raise one and the same UI answers it. */
export interface Question {
  /** The question text. */
  question: string;
  /** Optional short label (a chip/tag header, e.g. "Auth method"). */
  header?: string;
  options: QuestionOption[];
  /** Allow choosing more than one option. */
  multiSelect?: boolean;
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
  // Provider-specific MCP server config (opaque blob, e.g. `.mcp.json`'s
  // `mcpServers`). Applied live; the provider re-emits `mcp_status` after.
  | { kind: "set_mcp_servers"; servers: Record<string, unknown> }
  // Answer to a `question_request`: per-question, the chosen option labels (one
  // for single-select, one-or-more for multiSelect). Order mirrors `questions`.
  | { kind: "question_reply"; id: string; answers: string[][] }
  // Ask the provider to generate short suggested NEXT user replies for the given
  // recent-conversation text. Answered async with a `suggestions` Outbound. Runs
  // as a SEPARATE cheap one-shot call, not through the main agent loop.
  | { kind: "suggest"; conversation: string }
  // Run an OUT-OF-BAND agent turn for an inline comment thread (Notion-style):
  // the answer streams back as `comment_reply` events tagged with the same `id`
  // and NEVER enters the main session/transcript. `prompt` is the fully assembled
  // thread context (surrounding chat + selected text + prior thread Q&A + new
  // question), built app-side so the sidecar stays stateless. Like `suggest`, it
  // runs as a SEPARATE isolated one-shot query, not through the main agent loop.
  | { kind: "comment_turn"; id: string; prompt: string }
  // Abort an in-flight `comment_turn` for the given thread `id` (on popup close /
  // supersede). A no-op if nothing is running for that id.
  | { kind: "comment_cancel"; id: string };

/** The HARNESS's tool-permission vocabulary. Historically identical to the
 *  Claude SDK's `PermissionMode`, but the contract runs the other way: these four
 *  modes are trickshot's own protocol values, and every provider adapter MAPS its
 *  native permission semantics onto them (a provider without a native "plan" mode
 *  approximates or rejects it — it must not invent new wire values).
 *  `bypassPermissions` runs every tool without prompting (the historical
 *  default); the others route tool use through `canUseTool` → a
 *  `permission_request` the UI answers with `permission_reply`. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Session start-up configuration the app hands the sidecar. Serialized to JSON
 *  and passed via the `start_session` command → the `SESSION_CONFIG` env var →
 *  parsed ONCE in `core.ts` into the provider's `ProviderContext`. Shared by both
 *  TS ends (the app builds it in `ensureSession`, the sidecar reads it in
 *  `core.ts`) so the contract is compiler-checked, not hand-mirrored. Rust
 *  forwards the blob opaquely — adding a session knob is a field here plus reading
 *  it in the provider, with NO Rust signature or env-plumbing change. Every field
 *  is optional and provider-neutral. */
export interface SessionConfig {
  /** Which provider adapter the sidecar loads (default "claude"). */
  provider?: string;
  /** Prior agent session id to resume — restores the agent's context (NOT the
   *  rendered transcript, which the app rehydrates separately). */
  resumeSessionId?: string;
  /** Initial tool-permission mode (default `bypassPermissions`). */
  permissionMode?: PermissionMode;
  /** Extra text appended to the preset system prompt for custom behavior. */
  systemPromptAppend?: string;
  /** Provider-specific MCP server config (opaque blob, e.g. `.mcp.json`'s
   *  `mcpServers`). */
  mcpServers?: Record<string, unknown>;
  /** Provider-specific subagent definitions (opaque blob). */
  agents?: Record<string, unknown>;
}

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
  // The session's available slash commands (on ready and after get_commands).
  | { kind: "commands"; commands: SlashCommandInfo[] }
  // MCP server connection statuses (on ready and after set_mcp_servers).
  | { kind: "mcp_status"; servers: McpStatusInfo[] }
  // The agent wants attention (e.g. needs input). The app may raise an OS
  // notification, especially for a backgrounded (non-selected) worktree.
  | { kind: "notification"; message: string; notificationType?: string }
  // The agent is asking the user a structured question; the app shows a modal
  // and answers with `question_reply`. Provider-neutral (see Question).
  | { kind: "question_request"; id: string; questions: Question[] }
  // Suggested next user replies (answer to a `suggest` request). Provider-neutral;
  // empty array = none available (the UI renders nothing). The UI shows these as
  // pick-to-send chips alongside a "type your own" option.
  | { kind: "suggestions"; suggestions: string[] }
  // Streamed answer to a `comment_turn`, tagged with the thread `id`. `delta` is
  // incremental assistant text (one per assistant message, appended in order);
  // `done` marks the turn complete; `error` carries a failure. Out-of-band — the
  // app routes these to the comment thread's store, NEVER the main transcript.
  | { kind: "comment_reply"; id: string; delta?: string; done?: boolean; error?: string };
