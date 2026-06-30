// Claude provider: wraps `@anthropic-ai/claude-agent-sdk` and maps its native
// SDKMessage stream into the neutral `AgentMessage` schema. This is the ONLY
// Claude-aware module on the sidecar side — everything else (core.ts, the
// protocol, the whole UI) is provider-neutral. Use it as the template for a new
// provider: implement AgentProvider, emit neutral messages, register it.
//
// The pure, testable pieces live in sibling modules so this file stays focused on
// the agent loop + control wiring: native->neutral mapping (claudeMapping.ts),
// model tiers (claudeModels.ts), suggestion generation (claudeSuggest.ts), and
// the generic streaming input queue (queue.ts).

import {
  type AgentDefinition,
  createSdkMcpServer,
  type McpServerConfig,
  type PermissionResult,
  query,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ConnectorInfo, ModelInfo, PermissionMode } from "../../shared/protocol";
import { toNeutral } from "./claudeMapping";
import { DEFAULT_MODEL, ratings } from "./claudeModels";
import { generateSuggestions } from "./claudeSuggest";
import { makeQueue } from "./queue";
import type { AgentProvider, ProviderContext } from "./types";

// Always appended to the system prompt so the agent reaches for OUR question tool
// FIRST, instead of trying the built-in AskUserQuestion, getting denied, and only
// then falling back. (The built-in is also disallowed below as a hard backstop.)
const ASK_USER_GUIDANCE =
  "To ask the user a multiple-choice question, ALWAYS use the `mcp__trickshot__ask_user` " +
  "tool. NEVER use the built-in `AskUserQuestion` tool — it is disabled in this environment, " +
  "so attempting it only wastes a turn.";

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
  // In-flight suggestion request; aborted when superseded or when the user sends
  // a turn (they've moved on, so a late suggestion is stale).
  let suggestAbort: AbortController | null = null;

  // Single source for the stream-error path: normalize any thrown value and emit
  // it as an `error` Outbound. `onFlush` fires once the line hits stdout (used to
  // exit cleanly without truncating the final line — process.exit doesn't drain).
  const emitError = (e: unknown, onFlush?: () => void) =>
    ctx.emit({ kind: "error", error: e instanceof Error ? e.message : String(e) }, onFlush);

  // Run an async control request (a streaming-mode `q.*` call), surfacing any
  // failure as a stream error rather than throwing. `always` (optional) runs
  // afterward regardless of outcome — e.g. re-publish status so the UI refreshes.
  const runControl = (fn: () => Promise<void>, always?: () => void) =>
    void (async () => {
      try {
        await fn();
      } catch (e) {
        emitError(e);
      } finally {
        always?.();
      }
    })();

  // Historical default is bypassPermissions (silent tool use); the app overrides
  // it per-worktree via the SESSION_CONFIG blob (config.permissionMode, parsed
  // into ctx by core.ts).
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
          emitError(e, () => process.exit(1));
        }
      })();
    },

    pushTurn(text) {
      if (dead) return; // the loop has exited; nothing will consume this turn
      // The user is responding now — any in-flight suggestion is stale.
      suggestAbort?.abort();
      suggestAbort = null;
      turns.push({
        type: "user",
        message: { role: "user", content: String(text ?? "") },
        parent_tool_use_id: null,
      });
    },

    setModel(model) {
      if (!model || model === currentModel) return;
      // On success re-publish the catalog with the confirmed `current` so the UI
      // reflects sidecar truth.
      runControl(async () => {
        await q.setModel(model);
        currentModel = model;
        ctx.emit({ kind: "models", models: modelCatalog, current: currentModel });
      });
    },

    setPermissionMode(mode) {
      runControl(() => q.setPermissionMode(mode));
    },

    interrupt() {
      // interrupt() exists on the Query in streaming-input mode. Cast WHY: the SDK's
      // Query type doesn't surface it, so probe it structurally. Safe post-`dead`:
      // the process is already exiting, so a missing method is a no-op.
      const p = (q as { interrupt?: () => Promise<void> }).interrupt?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    },

    publishModels() {
      void publishModels();
    },

    publishConnectors() {
      void publishConnectors();
    },

    toggleConnector(name, enabled) {
      // Re-publish on success so the UI reflects sidecar truth.
      runControl(async () => {
        await q.toggleMcpServer(name, enabled);
        void publishConnectors();
      });
    },

    reconnectConnector(name) {
      // Reconnect throws on failure (e.g. a `needs-auth` connector that can't
      // complete OAuth from a headless sidecar). Surface it, but ALWAYS re-publish
      // (the `always` arg) so the UI's status refreshes after the attempt instead
      // of looking like nothing happened.
      runControl(
        () => q.reconnectMcpServer(name),
        () => void publishConnectors(),
      );
    },

    publishCommands() {
      void publishCommands();
    },

    setMcpServers(servers) {
      // Replace the dynamically-added MCP servers live, then refresh status.
      runControl(async () => {
        await q.setMcpServers(servers as Record<string, McpServerConfig>);
        void publishMcpStatus();
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

    suggest(conversation) {
      // Supersede any in-flight request, then run the one-shot suggestion query.
      // Manage abort/supersede state here; the query mechanics + parsing live in
      // claudeSuggest.ts. Fail-soft: generateSuggestions never throws.
      suggestAbort?.abort();
      const abort = new AbortController();
      suggestAbort = abort;
      void (async () => {
        const suggestions = await generateSuggestions({
          conversation,
          cliPath: ctx.cliPath,
          projectDir: ctx.projectDir,
          abort,
        });
        // Drop the result if a newer request (or a user turn) superseded this one.
        if (suggestAbort !== abort || abort.signal.aborted) return;
        suggestAbort = null;
        ctx.emit({ kind: "suggestions", suggestions });
      })();
    },
  };
}
