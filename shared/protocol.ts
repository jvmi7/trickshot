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

/** Provider-neutral transcript event. Every provider adapter maps its native
 *  output into these; the UI renders ONLY these (never provider-specific
 *  shapes). One message per semantic event: assistant prose, a tool call, a
 *  tool result, a session notice, or the end-of-turn marker. */
export type AgentMessage =
  | { type: "system"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; isError?: boolean }
  | { type: "turn_end" };

/** Messages flowing FROM the app TO the sidecar (sent as a JSON string via the
 *  `send_to_session` Tauri command). Provider-agnostic. */
export type Inbound =
  | { kind: "user_turn"; text: string }
  | { kind: "permission_reply"; id: string; behavior: "allow" | "deny"; message?: string }
  | { kind: "set_model"; model: string }
  | { kind: "get_models" }
  | { kind: "interrupt" };

/** Messages flowing FROM the sidecar TO the app. `message` carries the neutral
 *  `AgentMessage`; `session` reports the (provider-specific) resumable session
 *  id once known. */
export type Outbound =
  | { kind: "ready" }
  | { kind: "session"; id: string }
  | { kind: "message"; message: AgentMessage }
  | { kind: "permission_request"; id: string; tool: string; input: unknown }
  | { kind: "models"; models: ModelInfo[]; current: string }
  | { kind: "error"; error: string };
