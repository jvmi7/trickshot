// Claude provider: wraps `@anthropic-ai/claude-agent-sdk` and maps its native
// SDKMessage stream into the neutral `AgentMessage` schema. This is the ONLY
// Claude-aware module on the sidecar side — everything else (core.ts, the
// protocol, the whole UI) is provider-neutral. Use it as the template for a new
// provider: implement AgentProvider, emit neutral messages, register it.

import {
  type AgentDefinition,
  createSdkMcpServer,
  type McpServerConfig,
  type PermissionResult,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
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

// Always appended to the system prompt so the agent reaches for OUR question tool
// FIRST, instead of trying the built-in AskUserQuestion, getting denied, and only
// then falling back. (The built-in is also disallowed below as a hard backstop.)
const ASK_USER_GUIDANCE =
  "To ask the user a multiple-choice question, ALWAYS use the `mcp__trickshot__ask_user` " +
  "tool. NEVER use the built-in `AskUserQuestion` tool — it is disabled in this environment, " +
  "so attempting it only wastes a turn.";

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

// Shape of one Claude content block as it crosses the native->neutral seam. The
// SDK types `message.content` as loose `unknown`; the String()/typeof guards in
// toNeutral validate each field at runtime, so this confined type just removes the
// implicit `any` from the block iteration (matches the file's other confined casts).
type ContentBlock = {
  type?: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
};

// Map one Claude SDKMessage into zero or more neutral AgentMessages.
// Exported for unit testing (the native->neutral mapping is core correctness).
export function toNeutral(msg: SDKMessage): AgentMessage[] {
  // Non-null when the message came from a subagent (the spawning Agent tool's
  // id), forwarded thanks to forwardSubagentText. Lets the UI nest subagent work.
  const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id || undefined;
  const sub = parentId ? { parentId } : {};
  switch (msg.type) {
    case "assistant": {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      const blocks = (Array.isArray(content) ? content : []) as ContentBlock[];
      const out: AgentMessage[] = [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") {
          out.push({ type: "assistant", text: b.text, ...sub });
        } else if (b?.type === "tool_use") {
          out.push({
            type: "tool_call",
            id: String(b.id ?? ""),
            name: String(b.name ?? ""),
            input: b.input,
            ...sub,
          });
        }
      }
      return out;
    }
    case "user": {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      const blocks = (Array.isArray(content) ? content : []) as ContentBlock[];
      const out: AgentMessage[] = [];
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          out.push({
            type: "tool_result",
            id: String(b.tool_use_id ?? ""),
            content: typeof b.content === "string" ? b.content : JSON.stringify(b.content, null, 2),
            isError: b.is_error === true,
            ...sub,
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
      // Attach usage only when the result actually carried figures; a bare result
      // (e.g. the error subtype) maps to a plain turn_end (usage is optional).
      const hasUsage = Object.values(usage).some((v) => v !== undefined);
      return [hasUsage ? { type: "turn_end", usage } : { type: "turn_end" }];
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
  // Resolvers for in-flight `ask_user` questions, keyed by a generated id. Parked
  // by the tool handler (below), resolved by replyQuestion with the user's choices.
  const pendingQuestions = new Map<string, (answers: string[][]) => void>();
  let questionId = 0;
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

  // Provider-neutral "ask the user a question" path. The built-in AskUserQuestion
  // tool's answer channel isn't exposed to an SDK host, so we expose OUR OWN tool:
  // its handler emits a neutral question_request, parks a resolver, and returns the
  // user's choices as the tool result. The built-in is disallowed (see options) so
  // structured questions always funnel through this UI. A new provider asks via its
  // own mechanism but emits the SAME question_request — the UI is provider-neutral.
  const askUserTool = tool(
    "ask_user",
    "Ask the user one or more multiple-choice questions and wait for their answer. " +
      "Use this whenever you need the user to choose between options or make a decision " +
      "before continuing.",
    {
      questions: z
        .array(
          z.object({
            question: z.string().describe("The question to ask the user"),
            header: z.string().optional().describe("A short label/chip (<= 12 chars)"),
            options: z
              .array(
                z.object({
                  label: z.string().describe("The option text the user picks"),
                  description: z.string().optional().describe("What this option means"),
                }),
              )
              .min(2)
              .describe("At least two distinct choices"),
            multiSelect: z.boolean().optional().describe("Allow choosing more than one option"),
          }),
        )
        .min(1),
    },
    async (args) => {
      const id = `q-${questionId++}`;
      const answers = await new Promise<string[][]>((resolve) => {
        pendingQuestions.set(id, resolve);
        ctx.emit({ kind: "question_request", id, questions: args.questions });
      });
      // Hand the user's decision back to the model as the tool result text.
      const text = args.questions
        .map((qn, i) => `Q: ${qn.question}\nA: ${(answers[i] ?? []).join(", ") || "(no answer)"}`)
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );
  const trickshotServer = createSdkMcpServer({
    name: "trickshot",
    version: "1.0.0",
    tools: [askUserTool],
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
      // post-rename). Always append the ask_user guidance; tack the user's custom
      // append after it when present.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [ASK_USER_GUIDANCE, ctx.systemPromptAppend].filter(Boolean).join("\n\n"),
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
      // MCP servers: the user's config blob (provider-specific; cast at this single
      // boundary) PLUS our built-in `trickshot` server that hosts the `ask_user`
      // tool. Disallow the built-in AskUserQuestion so structured questions always
      // route through `ask_user` → the app's QuestionModal.
      mcpServers: {
        ...((ctx.mcpServers as Record<string, McpServerConfig>) ?? {}),
        trickshot: trickshotServer,
      },
      disallowedTools: ["AskUserQuestion"],
      // User-defined subagents (Record<name, def>); same opaque-blob + cast as MCP.
      // (Repo .claude/agents are also loaded via settingSources.)
      ...(ctx.agents ? { agents: ctx.agents as Record<string, AgentDefinition> } : {}),
      // Forward subagent text/thinking as messages tagged with parent_tool_use_id
      // so the UI can render a nested subagent transcript (not just a heartbeat).
      forwardSubagentText: true,
      // Surface agent "needs attention" notifications so the app can raise an OS
      // notification for a backgrounded worktree.
      hooks: {
        Notification: [
          {
            hooks: [
              async (input: unknown) => {
                const i = input as {
                  message?: string;
                  title?: string;
                  notification_type?: string;
                };
                ctx.emit({
                  kind: "notification",
                  message: i.message ?? i.title ?? "Agent notification",
                  notificationType: i.notification_type,
                });
                return {};
              },
            ],
          },
        ],
      },
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
        // Cast WHY: init reports status as a plain string; the `|| "connected"`
        // fallback guards a value outside the ConnectorInfo["status"] union.
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

  async function publishMcpStatus() {
    try {
      const servers = await q.mcpServerStatus();
      ctx.emit({
        kind: "mcp_status",
        servers: servers.map((s) => ({ name: s.name, status: s.status })),
      });
    } catch {
      // mcpServerStatus is a control request; if unavailable, leave it empty
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
      void publishMcpStatus();

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

    publishMcpStatus() {
      void publishMcpStatus();
    },

    setMcpServers(servers) {
      // Replace the dynamically-added MCP servers live, then refresh status.
      void q
        .setMcpServers(servers as Record<string, McpServerConfig>)
        .then(() => publishMcpStatus())
        .catch((e) => {
          ctx.emit({ kind: "error", error: e instanceof Error ? e.message : String(e) });
        });
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

    replyQuestion(id, answers) {
      // Settles the promise parked by the ask_user tool handler; the resolved
      // answers become the tool result the agent reads.
      const resolve = pendingQuestions.get(id);
      if (!resolve) return;
      pendingQuestions.delete(id);
      resolve(answers);
    },
  };
}
