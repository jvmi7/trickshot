// Shared sidecar core. Each platform entrypoint (agent.<platform>.ts) embeds the
// matching native Claude Code binary, extracts it from Bun's $bunfs at startup,
// and calls run(cliPath).
//
// Protocol (newline-delimited JSON):
//   stdin  (app -> sidecar):  Inbound  { kind: "user_turn" | "permission_reply" | "interrupt", ... }
//   stdout (sidecar -> app):  Outbound { kind: "ready" | "message" | "permission_request" | "error", ... }

import { query, type SDKUserMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";

// The default model a fresh session starts on (the UI can switch it per chat).
const DEFAULT_MODEL = "claude-opus-4-8";

/** A model the user can switch to (a trimmed SDK ModelInfo). */
type ModelLite = { value: string; displayName: string; description?: string };

type Outbound =
  | { kind: "ready" }
  | { kind: "message"; message: SDKMessage }
  | { kind: "permission_request"; id: string; tool: string; input: unknown }
  | { kind: "models"; models: ModelLite[]; current: string }
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

  // The model this session is currently using, and the catalog of switchable
  // models (fetched once on ready, cached so set_model can re-publish cheaply).
  let currentModel = DEFAULT_MODEL;
  let modelCatalog: ModelLite[] = [];

  const q = query({
    prompt: turns,
    options: {
      model: DEFAULT_MODEL,
      // Resume a prior session (id set by Rust from the per-worktree persisted
      // value) so chat history + agent context survive app restarts. The SDK
      // replays the prior messages on the stream when resuming. Absent on a
      // first run, where the SDK mints a fresh id we then capture and persist.
      resume: process.env.RESUME_SESSION || undefined,
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

  // Publish the switchable-model catalog + current selection. The catalog is
  // static, so it's fetched once and cached; later calls just re-send it. The UI
  // requests this on demand (get_models) because the ready-time broadcast can
  // race ahead of the app's async event-listener registration and be missed.
  async function publishModels() {
    if (modelCatalog.length === 0) {
      try {
        const models = await q.supportedModels();
        modelCatalog = models.map((m) => ({
          value: m.value,
          displayName: m.displayName ?? m.value,
          description: typeof m.description === "string" ? m.description : undefined,
        }));
      } catch {
        // supportedModels is a control request; if unavailable, advertise current only
      }
      if (modelCatalog.length === 0) {
        modelCatalog = [{ value: currentModel, displayName: currentModel }];
      }
    }
    send({ kind: "models", models: modelCatalog, current: currentModel });
  }

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
      case "set_model": {
        const model = String(cmd.model ?? "");
        if (!model || model === currentModel) break;
        // setModel is a streaming-mode control request (async). On success
        // re-publish the catalog with the confirmed `current` so the UI
        // reflects sidecar truth, not just an optimistic guess.
        void (async () => {
          try {
            await q.setModel(model);
            currentModel = model;
            send({ kind: "models", models: modelCatalog, current: currentModel });
          } catch (e) {
            send({ kind: "error", error: e instanceof Error ? e.message : String(e) });
          }
        })();
        break;
      }
      case "get_models":
        // On-demand catalog fetch — the resilient path the UI relies on.
        void publishModels();
        break;
    }
  });

  send({ kind: "ready" });
  // Best-effort broadcast on ready; the UI also re-requests via get_models in
  // case this races ahead of the listener (see publishModels).
  void publishModels();

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
