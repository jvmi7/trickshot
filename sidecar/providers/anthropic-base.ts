// Shared adapter for any provider reachable through the native `claude` binary
// + the Claude Agent SDK. The SDK speaks the Anthropic wire format, and Z.ai
// exposes an *Anthropic-compatible* endpoint, so the SAME binary serves both
// Claude and GLM — the only difference is the env the host spawns it with
// (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN, set by Rust for GLM) plus the
// default model and advertised catalog. This module owns the one agent loop;
// `claude.ts` and `glm.ts` are thin configs over it (extend, don't fork).

import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentMessage, ModelInfo } from "../../shared/protocol";
import type { AgentProvider, ProviderContext } from "./types";

/** Per-provider configuration for `createAnthropicProvider`. */
export interface AnthropicProviderConfig {
  /** Provider id (matches the registry key + AGENT_PROVIDER). */
  id: string;
  /** Model a fresh session starts on (the UI can switch within the catalog). */
  defaultModel: string;
  /** When true, fetch the live model catalog from the SDK (`supportedModels`).
   *  When false, advertise `staticCatalog` (e.g. an OpenAI-compatible endpoint
   *  the SDK can't enumerate). */
  useSdkCatalog: boolean;
  /** Catalog advertised when `useSdkCatalog` is false. */
  staticCatalog?: ModelInfo[];
  /** Maps a model (value, displayName) -> comparison pips for the SDK catalog. */
  ratings?: (value: string, displayName: string) => ModelInfo["meta"];
}

// A pushable async-iterable used as the streaming `prompt`. Never closed, so the
// session stays open for a multi-turn chat.
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

// Map one SDKMessage into zero or more neutral AgentMessages.
function toNeutral(msg: SDKMessage): AgentMessage[] {
  switch (msg.type) {
    case "assistant": {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      const blocks = Array.isArray(content) ? content : [];
      const out: AgentMessage[] = [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") {
          out.push({ type: "assistant", text: b.text });
        } else if (b?.type === "tool_use") {
          out.push({
            type: "tool_call",
            id: String(b.id ?? ""),
            name: String(b.name ?? ""),
            input: b.input,
          });
        }
      }
      return out;
    }
    case "user": {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      const blocks = Array.isArray(content) ? content : [];
      const out: AgentMessage[] = [];
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          out.push({
            type: "tool_result",
            id: String(b.tool_use_id ?? ""),
            content: typeof b.content === "string" ? b.content : JSON.stringify(b.content, null, 2),
            isError: b.is_error === true,
          });
        }
      }
      return out;
    }
    case "result":
      return [{ type: "turn_end" }];
    default:
      // `system`/init carries the session id (handled in the loop); stream/partial
      // internal types render nothing.
      return [];
  }
}

export function createAnthropicProvider(
  ctx: ProviderContext,
  config: AnthropicProviderConfig,
): AgentProvider {
  const turns = makeQueue<SDKUserMessage>();
  const pendingPermissions = new Map<string, (reply: unknown) => void>();
  let currentModel = config.defaultModel;
  let modelCatalog: ModelInfo[] = [];
  let lastSession = ctx.resumeSessionId ?? "";

  const q = query({
    prompt: turns,
    options: {
      model: config.defaultModel,
      // Resume a prior session (restores agent *context*; the SDK does NOT replay
      // messages, so the visible transcript is restored separately by the app).
      resume: ctx.resumeSessionId || undefined,
      cwd: ctx.projectDir,
      pathToClaudeCodeExecutable: ctx.cliPath,
      // Opt into Claude Code's system prompt (the SDK defaults to empty post-rename).
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Skip all permission prompts; the SDK never invokes canUseTool in this mode.
      permissionMode: "bypassPermissions",
    },
  });

  async function publishModels() {
    if (modelCatalog.length === 0) {
      if (config.useSdkCatalog) {
        try {
          const models = await q.supportedModels();
          modelCatalog = models.map((m) => ({
            value: m.value,
            displayName: m.displayName ?? m.value,
            description: typeof m.description === "string" ? m.description : undefined,
            meta: config.ratings?.(m.value, m.displayName ?? m.value),
          }));
        } catch {
          // supportedModels is a control request; if unavailable, advertise current only
        }
      } else if (config.staticCatalog?.length) {
        modelCatalog = config.staticCatalog;
      }
      if (modelCatalog.length === 0) {
        modelCatalog = [{ value: currentModel, displayName: currentModel }];
      }
    }
    ctx.emit({ kind: "models", models: modelCatalog, current: currentModel });
  }

  return {
    id: config.id,

    start() {
      ctx.emit({ kind: "ready" });
      // Best-effort broadcast; the UI also re-requests via get_models in case this
      // races ahead of the listener.
      void publishModels();

      // Drive the agent loop. With an open input queue this runs for the session's life.
      (async () => {
        try {
          for await (const message of q) {
            const sid = (message as { session_id?: unknown }).session_id;
            if (typeof sid === "string" && sid && sid !== lastSession) {
              lastSession = sid;
              ctx.emit({ kind: "session", id: sid });
            }
            for (const m of toNeutral(message)) ctx.emit({ kind: "message", message: m });
          }
        } catch (e) {
          ctx.emit({ kind: "error", error: e instanceof Error ? e.message : String(e) });
        }
      })();
    },

    pushTurn(text) {
      turns.push({
        type: "user",
        message: { role: "user", content: String(text ?? "") },
        parent_tool_use_id: null,
      } as SDKUserMessage);
    },

    setModel(model) {
      if (!model || model === currentModel) return;
      // setModel is a streaming-mode control request (async). On success re-publish
      // the catalog with the confirmed `current` so the UI reflects sidecar truth.
      void (async () => {
        try {
          await q.setModel(model);
          currentModel = model;
          ctx.emit({ kind: "models", models: modelCatalog, current: currentModel });
        } catch (e) {
          ctx.emit({ kind: "error", error: e instanceof Error ? e.message : String(e) });
        }
      })();
    },

    interrupt() {
      // interrupt() exists on the Query in streaming-input mode.
      const p = (q as { interrupt?: () => Promise<void> }).interrupt?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    },

    publishModels() {
      void publishModels();
    },

    replyPermission(id, _behavior, _message) {
      // Dormant under bypassPermissions (canUseTool is never called, so this map is
      // never populated). Retained for when bypass is disabled — see CLAUDE.md.
      const resolve = pendingPermissions.get(id);
      if (resolve) {
        pendingPermissions.delete(id);
        resolve({ behavior: _behavior, message: _message });
      }
    },
  };
}
