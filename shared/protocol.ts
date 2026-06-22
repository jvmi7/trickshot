// Single source of truth for the line-delimited JSON protocol spoken between the
// app and the sidecar. Imported by BOTH ends so the two TypeScript mirrors can't
// drift:
//   - the webview re-exports these from `src/lib/types.ts` (binding `Outbound`'s
//     message to the loose `SDKMessageLike`);
//   - the Bun sidecar imports them in `sidecar/core.ts` (binding to the SDK's
//     own `SDKMessage`).
//
// The Rust relay (`src-tauri/src/agent.rs`) and `ARCHITECTURE.md` still mirror
// this by hand — there is no compiler link to Rust. See the SYNC RULE in
// CLAUDE.md: changing a `kind`/payload here means editing those two as well, in
// the same commit.

/** A model the current chat can switch to (a trimmed SDK ModelInfo). */
export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
}

/** Messages flowing FROM the app TO the sidecar (sent as a JSON string via the
 *  `send_to_session` Tauri command). SDK-agnostic, so both ends share it as-is. */
export type Inbound =
  | { kind: "user_turn"; text: string }
  | { kind: "permission_reply"; id: string; behavior: "allow" | "deny"; message?: string }
  | { kind: "set_model"; model: string }
  | { kind: "get_models" }
  | { kind: "interrupt" };

/** Messages flowing FROM the sidecar TO the app. Generic over the SDK message
 *  representation: the sidecar forwards the SDK's own `SDKMessage`, while the
 *  webview reads it loosely as `SDKMessageLike`. Both bind `TMessage` in their
 *  own module so neither has to redeclare the union. */
export type Outbound<TMessage> =
  | { kind: "ready" }
  | { kind: "message"; message: TMessage }
  | { kind: "permission_request"; id: string; tool: string; input: unknown }
  | { kind: "models"; models: ModelInfo[]; current: string }
  | { kind: "error"; error: string };
