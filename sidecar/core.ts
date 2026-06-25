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
import type { Inbound, Outbound } from "../shared/protocol";
import { createProvider, DEFAULT_PROVIDER } from "./providers/registry";

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
    permissionMode: process.env.AGENT_PERMISSION || undefined,
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
      case "interrupt":
        provider.interrupt();
        break;
      case "permission_reply":
        provider.replyPermission(cmd.id, cmd.behavior, cmd.message);
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
