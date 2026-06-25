// The provider adapter contract. `core.ts` owns the wire transport (stdin/stdout
// framing + Inbound dispatch); a provider owns the actual agent loop and maps its
// native events into the neutral `AgentMessage` schema via `ctx.emit`. Adding a
// model provider = implement `AgentProvider` + register it in `registry.ts` —
// nothing else in the app or protocol changes.

import type { Outbound } from "../../shared/protocol";

/** What the host hands a provider when constructing it. */
export interface ProviderContext {
  /** Extracted native CLI path. Providers that don't shell a binary ignore it. */
  cliPath: string;
  /** Agent working directory (the worktree path). */
  projectDir: string;
  /** Prior session id to resume; provider-specific, may be ignored. */
  resumeSessionId?: string;
  /** How the agent treats tool permissions. Default (unset) = full bypass, the
   *  shipped behavior. A non-bypass value activates the canUseTool path so the
   *  app's Allow/Deny modal becomes a real kill-switch. Set by Rust via the
   *  AGENT_PERMISSION env (see core.ts). */
  permissionMode?: string;
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
  /** Answer a pending tool-permission request. Active when a non-bypass
   *  permissionMode is in effect; a no-op under the default full bypass. */
  replyPermission(id: string, behavior: "allow" | "deny", message?: string): void;
}

export type ProviderFactory = (ctx: ProviderContext) => AgentProvider;
