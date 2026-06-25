// Claude provider: wraps `@anthropic-ai/claude-agent-sdk` and maps its native
// SDKMessage stream into the neutral `AgentMessage` schema. This is the ONLY
// Claude-aware module on the sidecar side — everything else (core.ts, the
// protocol, the whole UI) is provider-neutral. Use it as the template for a new
// provider: implement AgentProvider, emit neutral messages, register it.

import {
  type PermissionResult,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentMessage,
  ConnectorInfo,
  ModelInfo,
  PermissionMode,
  TurnUsage,
} from "../../shared/protocol";
import type { AgentProvider, ProviderContext } from "./types";

// The default model a fresh session starts on (the UI can switch it per chat).
const DEFAULT_MODEL = "claude-opus-4-8";

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

// Claude tier -> comparison pips. This Claude-specific heuristic used to live in
// the UI (ModelSelector); it belongs with the provider that knows its own tiers.
function ratings(value: string, displayName: string): ModelInfo["meta"] {
  const s = `${value} ${displayName}`.toLowerCase();
  const context = /1m|\[1m\]/.test(s) ? 4 : 2;
  const r = s.includes("haiku")
    ? { reasoning: 2, speed: 4, value: 4 }
    : s.includes("opus")
      ? { reasoning: 4, speed: 2, value: 1 }
      : { reasoning: 3, speed: 3, value: 3 }; // sonnet / default / unknown
  return [
    { label: "Reasoning", score: r.reasoning },
    { label: "Speed", score: r.speed },
    { label: "Value", score: r.value },
    { label: "Context", score: context },
  ];
}

// Map one Claude SDKMessage into zero or more neutral AgentMessages.
// Exported for unit testing (the native->neutral mapping is core correctness).
export function toNeutral(msg: SDKMessage): AgentMessage[] {
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
    case "result": {
      // The result message ends a turn and carries cumulative token/cost figures
      // for it. Read defensively (the error subtype may omit some fields) and map
      // to the neutral TurnUsage; `total_cost_usd` is a client-side estimate.
      const r = msg as {
        total_cost_usd?: number;
        num_turns?: number;
        duration_ms?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      const u = r.usage ?? {};
      const usage: TurnUsage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheCreationTokens: u.cache_creation_input_tokens,
        costUsd: r.total_cost_usd,
        numTurns: r.num_turns,
        durationMs: r.duration_ms,
      };
      return [{ type: "turn_end", usage }];
    }
    default:
      // `system`/init carries the session id (handled in the loop); stream/partial
      // internal types render nothing.
      return [];
  }
}

export function createClaudeProvider(ctx: ProviderContext): AgentProvider {
  const turns = makeQueue<SDKUserMessage>();
  // Resolvers for in-flight permission prompts, keyed by a generated request id.
  // Populated by canUseTool when the mode is anything other than bypassPermissions;
  // resolved by replyPermission with the user's PermissionResult.
  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let permId = 0;
  let currentModel = DEFAULT_MODEL;
  let modelCatalog: ModelInfo[] = [];
  // Captured from the `system`/init message — the name+status fallback for the
  // connector list when the richer mcpServerStatus() control request is unavailable.
  let initServers: { name: string; status: string }[] = [];
  let lastSession = ctx.resumeSessionId ?? "";
  let dead = false;

  // Historical default is bypassPermissions (silent tool use); the app overrides
  // it per-worktree via the PERMISSION_MODE env (read into ctx by core.ts).
  const initialPermissionMode: PermissionMode = ctx.permissionMode ?? "bypassPermissions";

  // Gate one tool call. The SDK calls this ONLY when the active permission mode
  // requires approval (never under bypassPermissions). We surface the request to
  // the app and await the user's reply via the pendingPermissions resolver.
  const canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> =>
    new Promise<PermissionResult>((resolve) => {
      const id = `perm-${permId++}`;
      pendingPermissions.set(id, resolve);
      ctx.emit({ kind: "permission_request", id, tool: toolName, input });
    });

  const q = query({
    prompt: turns,
    options: {
      model: DEFAULT_MODEL,
      // Resume a prior session (restores agent *context*; the SDK does NOT replay
      // messages, so the visible transcript is restored separately by the app).
      resume: ctx.resumeSessionId || undefined,
      cwd: ctx.projectDir,
      pathToClaudeCodeExecutable: ctx.cliPath,
      // Load the user's + repo's settings (CLAUDE.md, .claude/commands, etc.) so
      // the agent respects project conventions and offers project slash commands.
      settingSources: ["user", "project"],
      // Opt into Claude Code's system prompt (the SDK defaults to empty
      // post-rename), with an optional per-session append for custom behavior.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(ctx.systemPromptAppend ? { append: ctx.systemPromptAppend } : {}),
      },
      // Initial gate for tool use; switchable live via setPermissionMode. Under
      // bypassPermissions the SDK never calls canUseTool (the dormant default) —
      // but it still REQUIRES the explicit opt-in flag (SDK 0.3.185), so set it
      // when starting in bypass. canUseTool stays wired regardless so a live
      // switch into a prompting mode actually surfaces the Allow/Deny modal.
      permissionMode: initialPermissionMode,
      canUseTool,
      ...(initialPermissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      // Back up files before edits so a turn's changes can be reverted by
      // rewindFiles (the per-turn "rewind to here" checkpoint feature).
      enableFileCheckpointing: true,
    },
  });

  async function publishModels() {
    if (modelCatalog.length === 0) {
      try {
        const models = await q.supportedModels();
        modelCatalog = models.map((m) => ({
          value: m.value,
          displayName: m.displayName ?? m.value,
          description: typeof m.description === "string" ? m.description : undefined,
          meta: ratings(m.value, m.displayName ?? m.value),
        }));
      } catch {
        // supportedModels is a control request; if unavailable, advertise current only
      }
      if (modelCatalog.length === 0) {
        modelCatalog = [{ value: currentModel, displayName: currentModel }];
      }
    }
    ctx.emit({ kind: "models", models: modelCatalog, current: currentModel });
  }

  // Mirror of publishModels for connectors: prefer the rich mcpServerStatus()
  // control request (per-tool detail + scope), fall back to the init message's
  // name+status list if that control request is unavailable.
  async function publishConnectors() {
    let servers: ConnectorInfo[] = [];
    try {
      const statuses = await q.mcpServerStatus();
      servers = statuses.map((s) => ({
        name: s.name,
        status: s.status,
        scope: s.scope,
        error: s.error,
        tools: (s.tools ?? []).map((t) => ({
          name: t.name,
          description: typeof t.description === "string" ? t.description : undefined,
          readOnly: t.annotations?.readOnly,
          destructive: t.annotations?.destructive,
        })),
      }));
    } catch {
      // mcpServerStatus is a control request; if unavailable, degrade to init.
    }
    if (servers.length === 0 && initServers.length > 0) {
      servers = initServers.map((s) => ({
        name: s.name,
        status: (s.status as ConnectorInfo["status"]) || "connected",
        tools: [],
      }));
    }
    ctx.emit({ kind: "connectors", servers });
  }

  async function publishCommands() {
    try {
      const cmds = await q.supportedCommands();
      ctx.emit({
        kind: "commands",
        commands: cmds.map((c) => ({ name: c.name, description: c.description ?? "" })),
      });
    } catch {
      // supportedCommands is a control request; if unavailable, leave it empty
    }
  }

  return {
    id: "claude",

    start() {
      ctx.emit({ kind: "ready" });
      // Best-effort broadcast; the UI also re-requests (get_models/get_connectors/
      // get_commands) in case this races ahead of the listener.
      void publishModels();
      void publishConnectors();
      void publishCommands();

      // Drive the agent loop. With an open input queue this runs for the session's life.
      (async () => {
        try {
          for await (const message of q) {
            const sid = (message as { session_id?: unknown }).session_id;
            if (typeof sid === "string" && sid && sid !== lastSession) {
              lastSession = sid;
              ctx.emit({ kind: "session", id: sid });
            }
            // The init message carries the configured MCP servers; cache them as
            // the connector fallback and re-publish (connectors are now known).
            const sys = message as {
              type?: string;
              subtype?: string;
              mcp_servers?: { name: string; status: string }[];
            };
            if (sys.type === "system" && sys.subtype === "init" && Array.isArray(sys.mcp_servers)) {
              initServers = sys.mcp_servers;
              void publishConnectors();
            }
            // Capture the provider-assigned id of a user turn (our own input echo,
            // not a tool-result or subagent message) as a rewindable checkpoint.
            if (message.type === "user") {
              const um = message as {
                uuid?: string;
                parent_tool_use_id?: string | null;
                message?: { content?: unknown };
              };
              const content = um.message?.content;
              const hasToolResult =
                Array.isArray(content) &&
                content.some((b) => (b as { type?: string })?.type === "tool_result");
              if (um.uuid && !hasToolResult && !um.parent_tool_use_id) {
                ctx.emit({ kind: "checkpoint", id: um.uuid });
              }
            }
            for (const m of toNeutral(message)) ctx.emit({ kind: "message", message: m });
          }
        } catch (e) {
          // The loop is the session's life; once it throws, the agent is dead but
          // the process would otherwise stay alive (stdin readline keeps it up),
          // leaving Rust with a live key it won't restart and a queue with no
          // consumer that silently swallows future turns. Surface the error, then
          // exit so Rust emits `terminated` and frees the session — but only AFTER
          // the line flushes (process.exit doesn't drain stdout, and a large error
          // line would otherwise be truncated into invalid JSON and dropped).
          dead = true;
          ctx.emit({ kind: "error", error: e instanceof Error ? e.message : String(e) }, () =>
            process.exit(1),
          );
        }
      })();
    },

    pushTurn(text) {
      if (dead) return; // the loop has exited; nothing will consume this turn
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

    setPermissionMode(mode) {
      // setPermissionMode is a streaming-mode control request (async). Fire and
      // forget; surface failures as a stream error rather than throwing.
      void q.setPermissionMode(mode).catch((e) => {
        ctx.emit({ kind: "error", error: e instanceof Error ? e.message : String(e) });
      });
    },

    interrupt() {
      // interrupt() exists on the Query in streaming-input mode.
      const p = (q as { interrupt?: () => Promise<void> }).interrupt?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    },

    rewind(messageId) {
      // Revert file changes made after the given user message (requires
      // enableFileCheckpointing, set above). Surface a failure as a stream error;
      // success is reflected by the app refreshing its git view.
      void q
        .rewindFiles(messageId)
        .then((r) => {
          if (!r.canRewind) {
            ctx.emit({ kind: "error", error: r.error || "cannot rewind to this point" });
          }
        })
        .catch((e) => {
          ctx.emit({ kind: "error", error: e instanceof Error ? e.message : String(e) });
        });
    },

    publishModels() {
      void publishModels();
    },

    publishConnectors() {
      void publishConnectors();
    },

    toggleConnector(name, enabled) {
      // toggleMcpServer is a streaming-mode control request (async). Re-publish on
      // success so the UI reflects sidecar truth; surface failures on the stream.
      void (async () => {
        try {
          await q.toggleMcpServer(name, enabled);
          void publishConnectors();
        } catch (e) {
          ctx.emit({ kind: "error", error: e instanceof Error ? e.message : String(e) });
        }
      })();
    },

    reconnectConnector(name) {
      void (async () => {
        try {
          await q.reconnectMcpServer(name);
        } catch (e) {
          // Reconnect throws on failure (e.g. a `needs-auth` connector that can't
          // complete OAuth from a headless sidecar). Surface it, but ALWAYS
          // re-publish below so the UI's status refreshes after the attempt
          // instead of looking like nothing happened.
          ctx.emit({ kind: "error", error: e instanceof Error ? e.message : String(e) });
        } finally {
          void publishConnectors();
        }
      })();
    },

    publishCommands() {
      void publishCommands();
    },

    replyPermission(id, behavior, message) {
      // Settles the promise parked by canUseTool. Active only when a non-bypass
      // permissionMode is in effect (under bypass the map is never populated).
      const resolve = pendingPermissions.get(id);
      if (!resolve) return;
      pendingPermissions.delete(id);
      resolve(
        behavior === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: message || "Denied by the user." },
      );
    },
  };
}
