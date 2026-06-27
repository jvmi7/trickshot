// The provider adapter contract. `core.ts` owns the wire transport (stdin/stdout
// framing + Inbound dispatch); a provider owns the actual agent loop and maps its
// native events into the neutral `AgentMessage` schema via `ctx.emit`. Adding a
// model provider = implement `AgentProvider` + register it in `registry.ts` —
// nothing else in the app or protocol changes.

import type { Outbound, PermissionMode } from "../../shared/protocol";

/** What the host hands a provider when constructing it. */
export interface ProviderContext {
  /** Extracted native CLI path. Providers that don't shell a binary ignore it. */
  cliPath: string;
  /** Agent working directory (the worktree path). */
  projectDir: string;
  /** Prior session id to resume; provider-specific, may be ignored. */
  resumeSessionId?: string;
  /** Initial permission mode for tool use, set per-worktree by Rust via the
   *  PERMISSION_MODE env (see core.ts) and defaulting to bypassPermissions.
   *  A non-bypass value activates the canUseTool path so the app's Allow/Deny
   *  modal becomes a real kill-switch; switchable live via setPermissionMode. */
  permissionMode?: PermissionMode;
  /** Optional text appended to the preset system prompt for custom behavior. */
  systemPromptAppend?: string;
  /** Optional provider-specific MCP server config (opaque blob from the app). */
  mcpServers?: Record<string, unknown>;
  /** Optional provider-specific subagent definitions (opaque blob from the app). */
  agents?: Record<string, unknown>;
  /** Emit a wire event to the app. The provider never touches stdout directly.
   *  `onFlush` (optional) fires once the line has been handed to stdout — use it
   *  to exit cleanly without truncating the final line (process.exit doesn't
   *  drain a pipe-buffered stdout). */
  emit: (event: Outbound, onFlush?: () => void) => void;
}

/** A pluggable agent backend. */
export interface AgentProvider {
  readonly id: string;
  /** Begin the agent loop; emit `ready` and (when known) `models`. */
  start(): void;
  /** Queue a user turn. */
  pushTurn(text: string): void;
  /** Switch model, then re-emit `models` with the confirmed `current`. */
  setModel(model: string): void;
  /** Switch the permission mode for subsequent tool use (live, mid-session). */
  setPermissionMode(mode: PermissionMode): void;
  /** Interrupt the in-flight turn. */
  interrupt(): void;
  /** (Re-)emit the `models` event (catalog + current). */
  publishModels(): void;
  /** (Re-)emit the `connectors` event (MCP servers + their tools/status). */
  publishConnectors(): void;
  /** Enable or disable an MCP connector live, then re-emit `connectors`. */
  toggleConnector(name: string, enabled: boolean): void;
  /** Reconnect an MCP connector (e.g. after a failure), then re-emit `connectors`. */
  reconnectConnector(name: string): void;
  /** (Re-)emit the `commands` event (available slash commands). */
  publishCommands(): void;
  /** (Re-)emit the `mcp_status` event (MCP server connection statuses). */
  publishMcpStatus(): void;
  /** Replace the live MCP server set, then refresh status. */
  setMcpServers(servers: Record<string, unknown>): void;
  /** Answer a pending tool-permission request. Active when a non-bypass
   *  permissionMode is in effect; a no-op under the default full bypass. */
  replyPermission(id: string, behavior: "allow" | "deny", message?: string): void;
  /** Answer a pending `question_request` with the user's per-question choices. */
  replyQuestion(id: string, answers: string[][]): void;
  /** Generate short suggested NEXT user replies for the given recent-conversation
   *  text and emit them as a `suggestions` event. Best-effort: a failure emits an
   *  empty list, never throws. Runs as a one-shot call independent of the main loop. */
  suggest(conversation: string): void;
}

export type ProviderFactory = (ctx: ProviderContext) => AgentProvider;
