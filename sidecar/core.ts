// Shared sidecar core. Each platform entrypoint (agent.<platform>.ts) embeds the
// matching native Claude Code binary, extracts it from Bun's $bunfs at startup,
// and calls run(cliPath).
//
// Protocol (newline-delimited JSON):
//   stdin  (app -> sidecar):  Inbound  { kind: "user_turn" | "permission_reply" | "interrupt", ... }
//   stdout (sidecar -> app):  Outbound { kind: "ready" | "message" | "permission_request" | "error", ... }

import { query, type SDKUserMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";

type Outbound =
  | { kind: "ready" }
  | { kind: "message"; message: SDKMessage }
  | { kind: "permission_request"; id: string; tool: string; input: unknown }
  | { kind: "error"; error: string };

function send(o: Outbound) {
  process.stdout.write(JSON.stringify(o) + "\n");
}

// A pushable async-iterable used as the streaming `prompt`. We never close it,
// so the session stays open for a multi-turn chat.
function makeQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  return {
    push(item: T) {
      items.push(item);
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) {
          yield items.shift() as T;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

export function run(cliPath: string) {
  const turns = makeQueue<SDKUserMessage>();
  const pendingPermissions = new Map<string, (reply: any) => void>();

  const q = query({
    prompt: turns,
    options: {
      model: "claude-opus-4-8",
      cwd: process.env.PROJECT_DIR ?? process.cwd(),
      // The extracted native CLI binary (see platform entrypoints).
      pathToClaudeCodeExecutable: cliPath,
      // Opt into Claude Code's system prompt (the SDK defaults to empty post-rename).
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Skip all permission prompts. In bypassPermissions mode the SDK never
      // invokes canUseTool, so no tool is routed through the app's UI.
      permissionMode: "bypassPermissions",
    },
  });

  // Read commands from stdin.
  createInterface({ input: process.stdin }).on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let cmd: any;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      return;
    }
    switch (cmd.kind) {
      case "user_turn":
        turns.push({
          type: "user",
          message: { role: "user", content: String(cmd.text ?? "") },
          parent_tool_use_id: null,
        } as SDKUserMessage);
        break;
      case "permission_reply": {
        const resolve = pendingPermissions.get(cmd.id);
        if (resolve) {
          pendingPermissions.delete(cmd.id);
          resolve(cmd);
        }
        break;
      }
      case "interrupt": {
        // interrupt() exists on the Query in streaming-input mode.
        const p = (q as any).interrupt?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
        break;
      }
    }
  });

  send({ kind: "ready" });

  // Drive the agent loop. With an open input queue this runs for the life of the session.
  (async () => {
    try {
      for await (const message of q) {
        send({ kind: "message", message });
      }
    } catch (e) {
      send({ kind: "error", error: e instanceof Error ? e.message : String(e) });
    }
  })();
}
