// Shared sidecar core — the provider-neutral transport. Each platform entrypoint
// (agent.<platform>.ts) embeds the matching native Claude Code binary, extracts
// it from Bun's $bunfs at startup, and calls run(cliPath).
//
// This module owns ONLY the wire: it frames newline-delimited JSON, dispatches
// each Inbound command to the selected provider, and lets the provider emit
// Outbound events. All model/agent logic lives behind the AgentProvider adapter
// (see sidecar/providers/) — core.ts has no Claude import.
//
// Protocol (newline-delimited JSON):
//   stdin  (app -> sidecar):  Inbound   { kind: "user_turn" | "set_model" | "interrupt" | ... }
//   stdout (sidecar -> app):  Outbound  { kind: "ready" | "session" | "message" | "models" | "error" | ... }

import { createInterface } from "node:readline";
import type { Inbound, Outbound, PermissionMode } from "../shared/protocol";
import { createProvider, DEFAULT_PROVIDER } from "./providers/registry";

/** Parse a JSON-object env var (MCP servers / agent defs) into a record, or undefined. */
function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function run(cliPath: string) {
  // Serialize one compact object per line; the newline is the only framing.
  // `onFlush` fires once the chunk is flushed (lets a provider exit without
  // truncating its last line — process.exit doesn't drain a pipe).
  const emit = (o: Outbound, onFlush?: () => void) =>
    process.stdout.write(JSON.stringify(o) + "\n", onFlush);

  const provider = createProvider(process.env.AGENT_PROVIDER ?? DEFAULT_PROVIDER, {
    cliPath,
    projectDir: process.env.PROJECT_DIR ?? process.cwd(),
    resumeSessionId: process.env.RESUME_SESSION || undefined,
    permissionMode: (process.env.PERMISSION_MODE as PermissionMode) || undefined,
    systemPromptAppend: process.env.SYSTEM_PROMPT_APPEND || undefined,
    mcpServers: parseJsonObject(process.env.MCP_SERVERS),
    agents: parseJsonObject(process.env.AGENTS),
    emit,
  });

  // Read commands from stdin and dispatch to the provider.
  createInterface({ input: process.stdin }).on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let cmd: Inbound;
    try {
      cmd = JSON.parse(trimmed) as Inbound;
    } catch {
      return;
    }
    switch (cmd.kind) {
      case "user_turn":
        provider.pushTurn(cmd.text);
        break;
      case "set_model":
        provider.setModel(cmd.model);
        break;
      case "set_permission_mode":
        provider.setPermissionMode(cmd.mode);
        break;
      case "get_models":
        provider.publishModels();
        break;
      case "get_connectors":
        provider.publishConnectors();
        break;
      case "toggle_connector":
        provider.toggleConnector(cmd.name, cmd.enabled);
        break;
      case "reconnect_connector":
        provider.reconnectConnector(cmd.name);
        break;
      case "get_commands":
        provider.publishCommands();
        break;
      case "get_mcp_status":
        provider.publishMcpStatus();
        break;
      case "set_mcp_servers":
        provider.setMcpServers(cmd.servers);
        break;
      case "interrupt":
        provider.interrupt();
        break;
      case "rewind":
        provider.rewind(cmd.messageId);
        break;
      case "permission_reply":
        provider.replyPermission(cmd.id, cmd.behavior, cmd.message);
        break;
      case "question_reply":
        provider.replyQuestion(cmd.id, cmd.answers);
        break;
      default: {
        // Exhaustiveness guard: a new Inbound `kind` added to the protocol
        // without a case here is now a COMPILE error (the sidecar is typechecked
        // in CI via tsconfig.sidecar.json). Without this, a one-sided protocol
        // edit toward the sidecar would be silently dropped (see SYNC RULE).
        const _exhaustive: never = cmd;
        void _exhaustive;
      }
    }
  });

  provider.start();
}
