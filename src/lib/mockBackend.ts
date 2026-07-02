// Browser-mode mock backend — the E2E harness's stand-in for the Rust core +
// sidecar. Loaded ONLY under `vite --mode mock` (see main.ts); never part of a
// production build. It uses Tauri's official mock layer (`@tauri-apps/api/mocks`)
// to intercept `invoke()`/`listen()` beneath api.ts, so the REAL api.ts parsing
// (stdout line-splitting, JSON framing, the AgentEnvelope routing) stays
// exercised — only the two native processes are faked.
//
// The fake agent answers `user_turn`s with deterministic keyword-triggered
// scripts (see runTurn) so a driver (Playwright) can exercise every UI flow —
// tool rendering, permission/question modals, errors, session death — without a
// live Claude login. Everything is deterministic: no randomness, fixed delays.
//
// This file talks the SAME wire contract as the sidecar (`shared/protocol.ts`
// via ./types) and mirrors the Rust command results (snake_case fields). It is
// NOT part of the SYNC RULE seams — a new command/kind shows up here as a
// compile error via the `Inbound`/`Outbound` unions or a failing e2e run.

import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type {
  AgentEnvelope,
  ConnectorInfo,
  GitStatus,
  Inbound,
  ModelInfo,
  Outbound,
  PermissionMode,
  SessionConfig,
  SlashCommandInfo,
  UsageInfo,
  Worktree,
} from "./types";

// ---- Fixture world --------------------------------------------------------

export const MOCK_REPO = "/mock/trickshot";
export const MOCK_MAIN_WT = "/mock/trickshot";
export const MOCK_FEATURE_WT = "/mock/.trickshot-worktrees/feature-streaming";

const MODELS: ModelInfo[] = [
  {
    value: "mock-opus",
    displayName: "Mock Opus",
    description: "Most capable mock model",
    meta: [
      { label: "Speed", score: 2 },
      { label: "Intelligence", score: 4 },
    ],
  },
  {
    value: "mock-sonnet",
    displayName: "Mock Sonnet",
    description: "Balanced mock model",
    meta: [
      { label: "Speed", score: 3 },
      { label: "Intelligence", score: 3 },
    ],
  },
  {
    value: "mock-haiku",
    displayName: "Mock Haiku",
    description: "Fastest mock model",
    meta: [
      { label: "Speed", score: 4 },
      { label: "Intelligence", score: 2 },
    ],
  },
];

const COMMANDS: SlashCommandInfo[] = [
  { name: "review", description: "Review the current diff" },
  { name: "tests", description: "Run the test suite" },
];

const defaultConnectors = (): ConnectorInfo[] => [
  {
    name: "github",
    status: "connected",
    scope: "user",
    tools: [
      { name: "search_issues", description: "Search issues", readOnly: true },
      { name: "merge_pull_request", description: "Merge a PR", destructive: true },
    ],
  },
  { name: "linear", status: "needs-auth", scope: "project", tools: [] },
];

interface MockGitFile {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
}

interface MockSession {
  id: string;
  model: string;
  permissionMode: PermissionMode;
  connectors: ConnectorInfo[];
  /** Pending timeouts for the in-flight turn, cancelled on interrupt/stop. */
  timers: Set<number>;
}

const worktreesByRepo = new Map<string, Worktree[]>();
const sessions = new Map<string, MockSession>();
const gitFiles = new Map<string, MockGitFile[]>();
let sessionCounter = 0;
let repoCounter = 0;

const wt = (path: string, branch: string, isMain: boolean): Worktree => ({
  path,
  branch,
  head: "abc1234",
  is_main: isMain,
  locked: false,
});

function seedRepo(repoPath: string) {
  if (worktreesByRepo.has(repoPath)) return;
  worktreesByRepo.set(
    repoPath,
    repoPath === MOCK_REPO
      ? [wt(MOCK_MAIN_WT, "main", true), wt(MOCK_FEATURE_WT, "feature/streaming", false)]
      : [wt(repoPath, "main", true)],
  );
}

/** Dirty-file fixture for a worktree (lazily seeded so status/diff/stage flows
 *  have something to show; commit clears it). */
function filesFor(worktree: string): MockGitFile[] {
  let f = gitFiles.get(worktree);
  if (!f) {
    f = [
      { path: "src/lib/api.ts", index: " ", worktree: "M", staged: false },
      { path: "src/lib/components/Chat.svelte", index: " ", worktree: "M", staged: false },
    ];
    gitFiles.set(worktree, f);
  }
  return f;
}

const MOCK_DIFF = `diff --git a/src/lib/api.ts b/src/lib/api.ts
index 1111111..2222222 100644
--- a/src/lib/api.ts
+++ b/src/lib/api.ts
@@ -1,5 +1,6 @@
 // Typed wrapper over the Tauri command surface + agent event stream.
+// (mock diff line for the E2E harness)
 import { invoke } from "@tauri-apps/api/core";
-import { listen } from "@tauri-apps/api/event";
+import { listen, type UnlistenFn } from "@tauri-apps/api/event";
`;

// ---- Wire helpers ---------------------------------------------------------

/** Relay one envelope on the `agent-event` channel — exactly what agent.rs does. */
function emitEnvelope(worktree: string, kind: AgentEnvelope["kind"], data: string | null) {
  void emit("agent-event", { worktree, kind, data } satisfies AgentEnvelope);
}

/** One protocol message, framed exactly like the sidecar writes it (one compact
 *  JSON object per stdout line). */
function send(worktree: string, msg: Outbound) {
  emitEnvelope(worktree, "stdout", `${JSON.stringify(msg)}\n`);
}

function schedule(s: MockSession, delayMs: number, fn: () => void) {
  const id = window.setTimeout(() => {
    s.timers.delete(id);
    fn();
  }, delayMs);
  s.timers.add(id);
}

function cancelTimers(s: MockSession) {
  for (const id of s.timers) window.clearTimeout(id);
  s.timers.clear();
}

// ---- The scripted agent ---------------------------------------------------

const STEP_MS = 60; // per-message delay: fast, but async enough to exercise batching

/** Emit a sequence of Outbound messages spaced STEP_MS apart (cancellable). */
function play(worktree: string, s: MockSession, msgs: Outbound[]) {
  msgs.forEach((m, i) => {
    schedule(s, STEP_MS * (i + 1), () => send(worktree, m));
  });
}

const turnEnd = (steps: number): Outbound => ({
  kind: "message",
  message: {
    type: "turn_end",
    usage: {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 8000,
      costUsd: 0.0123,
      numTurns: 1,
      durationMs: STEP_MS * (steps + 1),
    },
  },
});

const assistant = (text: string): Outbound => ({
  kind: "message",
  message: { type: "assistant", text },
});

let toolCounter = 0;
function toolPair(name: string, input: unknown, content: string, isError = false): Outbound[] {
  const id = `tool-${++toolCounter}`;
  return [
    { kind: "message", message: { type: "tool_call", id, name, input } },
    { kind: "message", message: { type: "tool_result", id, content, isError } },
  ];
}

const MARKDOWN_REPLY = `Here's a **markdown** sample:

## Heading

- a list item
- another with \`inline code\`

\`\`\`ts
const x: number = 42;
\`\`\`

> and a blockquote to finish.`;

/** The deterministic turn scripts, keyed by keywords in the user's text. Drivers
 *  (Playwright / an agent) pick a flow by wording the message; the FIRST match
 *  wins, and anything else gets the plain echo turn. Keep this list in sync with
 *  the CLAUDE.md "mock triggers" table. */
function runTurn(worktree: string, s: MockSession, text: string) {
  const t = text.toLowerCase();

  if (t.includes("crash")) {
    // Simulated sidecar death: stderr tail then an abnormal exit — exercises the
    // api.ts stderr buffering + the handleSessionStatus "stopped" path.
    schedule(s, STEP_MS, () => emitEnvelope(worktree, "stderr", "mock: simulated sidecar panic\n"));
    schedule(s, STEP_MS * 2, () => {
      sessions.delete(worktree);
      emitEnvelope(worktree, "terminated", "1");
    });
    return;
  }

  if (t.includes("fail")) {
    play(worktree, s, [
      { kind: "error", error: "mock: something went wrong mid-turn" },
      assistant("That errored, but I recovered and finished the turn."),
      turnEnd(0),
    ]);
    return;
  }

  if (t.includes("permission")) {
    // Parks the turn on a permission_request; permission_reply resumes it.
    play(worktree, s, [
      {
        kind: "permission_request",
        id: `perm-${++toolCounter}`,
        tool: "Bash",
        input: { command: "rm -rf ./build" },
      },
    ]);
    return;
  }

  if (t.includes("question")) {
    // Parks the turn on a question_request; question_reply resumes it.
    play(worktree, s, [
      {
        kind: "question_request",
        id: `q-${++toolCounter}`,
        questions: [
          {
            question: "Which database should the feature use?",
            header: "Database",
            options: [
              { label: "Postgres", description: "Relational, battle-tested" },
              { label: "SQLite", description: "Embedded, zero-config" },
            ],
          },
        ],
      },
    ]);
    return;
  }

  if (t.includes("burst")) {
    // A heavy tool burst — exercises transcript batching + tool grouping + windowing.
    const msgs: Outbound[] = [];
    for (let i = 0; i < 25; i++) {
      msgs.push(
        ...toolPair(
          "Read",
          { file_path: `src/file-${i}.ts` },
          `contents of file ${i}\n`.repeat(30),
        ),
      );
    }
    msgs.push(assistant("Read 25 files in a burst."), turnEnd(25));
    play(worktree, s, msgs);
    return;
  }

  if (t.includes("tool")) {
    play(worktree, s, [
      ...toolPair("Read", { file_path: "src/lib/stores.ts" }, "// 600 lines of stores…\n"),
      ...toolPair("Bash", { command: "bun test" }, "12 pass, 0 fail\n"),
      assistant("I ran two tools: read `stores.ts`, then ran the tests — all green."),
      turnEnd(2),
    ]);
    return;
  }

  if (t.includes("notify")) {
    play(worktree, s, [
      {
        kind: "notification",
        message: "The agent wants your attention",
        notificationType: "attention",
      },
      assistant("Sent a notification."),
      turnEnd(0),
    ]);
    return;
  }

  if (t.includes("markdown")) {
    play(worktree, s, [assistant(MARKDOWN_REPLY), turnEnd(0)]);
    return;
  }

  // Default: plain echo turn.
  play(worktree, s, [assistant(`Mock agent (${s.model}) received: "${text}"`), turnEnd(0)]);
}

function handleInbound(worktree: string, s: MockSession, msg: Inbound) {
  switch (msg.kind) {
    case "user_turn":
      runTurn(worktree, s, msg.text);
      break;
    case "interrupt":
      cancelTimers(s);
      send(worktree, turnEnd(0));
      break;
    case "permission_reply":
      play(worktree, s, [
        ...(msg.behavior === "allow"
          ? [
              ...toolPair("Bash", { command: "rm -rf ./build" }, "removed ./build\n"),
              assistant("Permission granted — command ran."),
            ]
          : [assistant("Permission denied — I skipped that command.")]),
        turnEnd(msg.behavior === "allow" ? 1 : 0),
      ]);
      break;
    case "question_reply":
      play(worktree, s, [
        assistant(`Great — going with **${msg.answers.map((a) => a.join(", ")).join("; ")}**.`),
        turnEnd(0),
      ]);
      break;
    case "suggest":
      play(worktree, s, [
        {
          kind: "suggestions",
          suggestions: ["Sounds good, continue", "Show me the diff", "Run the tests"],
        },
      ]);
      break;
    case "set_model":
      s.model = msg.model;
      send(worktree, { kind: "models", models: MODELS, current: s.model });
      break;
    case "get_models":
      send(worktree, { kind: "models", models: MODELS, current: s.model });
      break;
    case "get_connectors":
      send(worktree, { kind: "connectors", servers: s.connectors });
      break;
    case "toggle_connector":
      s.connectors = s.connectors.map((c) =>
        c.name === msg.name ? { ...c, status: msg.enabled ? "connected" : "disabled" } : c,
      );
      send(worktree, { kind: "connectors", servers: s.connectors });
      break;
    case "reconnect_connector":
      s.connectors = s.connectors.map((c) =>
        c.name === msg.name ? { ...c, status: "connected" } : c,
      );
      send(worktree, { kind: "connectors", servers: s.connectors });
      break;
    case "get_commands":
      send(worktree, { kind: "commands", commands: COMMANDS });
      break;
    case "set_permission_mode":
      s.permissionMode = msg.mode;
      break;
    case "set_mcp_servers":
      send(worktree, {
        kind: "mcp_status",
        servers: Object.keys(msg.servers).map((name) => ({ name, status: "connected" })),
      });
      break;
    default: {
      // Exhaustiveness: a new Inbound `kind` unhandled by the mock is a compile
      // error, mirroring core.ts's dispatch guard.
      const _exhaustive: never = msg;
      void _exhaustive;
    }
  }
}

// ---- Command surface (mirrors lib.rs' generate_handler! list) --------------

/** Every `start_session` call this page-load, with its parsed config — lets a
 *  driver assert the resume contract (a relaunch must carry `resumeSessionId`). */
export const sessionStarts: { worktree: string; config: SessionConfig }[] = [];

function startSession(worktree: string, configJson: string | undefined) {
  let config: SessionConfig = {};
  try {
    config = configJson ? (JSON.parse(configJson) as SessionConfig) : {};
  } catch {
    /* opaque blob, tolerate garbage like Rust does */
  }
  sessionStarts.push({ worktree, config });
  if (sessions.has(worktree)) return; // idempotent, like agent.rs
  const s: MockSession = {
    id: config.resumeSessionId ?? `mock-session-${++sessionCounter}`,
    model: "mock-opus",
    permissionMode: config.permissionMode ?? "bypassPermissions",
    connectors: defaultConnectors(),
    timers: new Set(),
  };
  sessions.set(worktree, s);
  // The ready-time broadcast, in the same order providers/claude.ts emits it.
  play(worktree, s, [
    { kind: "ready" },
    { kind: "session", id: s.id },
    { kind: "models", models: MODELS, current: s.model },
    { kind: "commands", commands: COMMANDS },
    { kind: "connectors", servers: s.connectors },
    { kind: "mcp_status", servers: [{ name: "github", status: "connected" }] },
  ]);
}

const USAGE: UsageInfo = {
  five_hour: { utilization: 32, resets_at: "2099-01-01T00:00:00Z" },
  seven_day: { utilization: 12, resets_at: "2099-01-07T00:00:00Z" },
};

/** Desktop notifications raised via the `notify` command, recorded for tests. */
export const notifications: { title: string; body: string }[] = [];

type Args = Record<string, unknown>;

function handleCommand(cmd: string, rawArgs: unknown): unknown {
  // One confined cast: mockIPC hands us `unknown` args; every command below reads
  // the camelCase fields api.ts sent (the boundary contract).
  const a = (rawArgs ?? {}) as Args;
  const worktree = a.worktree as string;
  switch (cmd) {
    case "pick_directory":
      return `/mock/demo-repo-${++repoCounter}`;
    case "notify":
      notifications.push({ title: a.title as string, body: a.body as string });
      return null;
    case "get_usage":
      return USAGE;
    case "list_worktrees": {
      const repoPath = a.repoPath as string;
      seedRepo(repoPath);
      return worktreesByRepo.get(repoPath);
    }
    case "create_worktree": {
      const repoPath = a.repoPath as string;
      seedRepo(repoPath);
      const list = worktreesByRepo.get(repoPath) ?? [];
      const branch = a.branch as string;
      if (list.some((w) => w.branch === branch))
        throw new Error(`branch '${branch}' already exists`);
      const name = repoPath.split("/").pop() ?? "repo";
      const created = wt(`/mock/.${name}-worktrees/${branch.replace(/\//g, "-")}`, branch, false);
      worktreesByRepo.set(repoPath, [...list, created]);
      return created;
    }
    case "remove_worktree": {
      const repoPath = a.repoPath as string;
      const list = worktreesByRepo.get(repoPath) ?? [];
      worktreesByRepo.set(
        repoPath,
        list.filter((w) => w.path !== a.worktreePath),
      );
      return null;
    }
    case "worktree_status": {
      const wtPath = a.worktreePath as string;
      const files = filesFor(wtPath);
      const branch =
        [...worktreesByRepo.values()].flat().find((w) => w.path === wtPath)?.branch ?? "main";
      return {
        branch,
        ahead: 0,
        behind: 0,
        insertions: files.length * 4,
        deletions: files.length,
        files,
      } satisfies GitStatus;
    }
    case "worktree_diff":
      return MOCK_DIFF;
    case "worktree_stage": {
      const paths = a.paths as string[];
      for (const f of filesFor(a.worktreePath as string)) {
        if (paths.length === 0 || paths.includes(f.path)) f.staged = true;
      }
      return null;
    }
    case "worktree_unstage": {
      const paths = a.paths as string[];
      for (const f of filesFor(a.worktreePath as string)) {
        if (paths.length === 0 || paths.includes(f.path)) f.staged = false;
      }
      return null;
    }
    case "worktree_commit": {
      gitFiles.set(a.worktreePath as string, []);
      return "mock: committed";
    }
    case "worktree_push":
      return "mock: pushed";
    case "worktree_merge":
      return "mock: merged";
    case "start_session":
      startSession(worktree, a.config as string | undefined);
      return null;
    case "stop_session": {
      const s = sessions.get(worktree);
      if (s) {
        cancelTimers(s);
        sessions.delete(worktree);
        emitEnvelope(worktree, "terminated", null);
      }
      return null;
    }
    case "send_to_session": {
      const s = sessions.get(worktree);
      if (!s) throw new Error(`no session for ${worktree}`);
      handleInbound(worktree, s, JSON.parse(a.payload as string) as Inbound);
      return null;
    }
    default:
      throw new Error(`mock backend: unknown command '${cmd}'`);
  }
}

// ---- Install ---------------------------------------------------------------

declare global {
  interface Window {
    /** Escape hatch for a driver (Playwright) to inject arbitrary protocol
     *  events or inspect side effects the mock recorded. */
    __trickshotMock?: {
      send: typeof send;
      emitEnvelope: typeof emitEnvelope;
      notifications: typeof notifications;
      sessionStarts: typeof sessionStarts;
    };
  }
}

/** Install the mock backend. MUST run before the app mounts (so onMount-time
 *  invoke()/listen() calls hit the mock) — see main.ts. */
export function installMockBackend() {
  // Seed a repo into the sidebar on a fresh profile so a driver lands on a
  // populated UI. An existing persisted list (a test that set its own) wins.
  try {
    if (!localStorage.getItem("trickshot.repos")) {
      localStorage.setItem(
        "trickshot.repos",
        JSON.stringify([{ path: MOCK_REPO, name: "trickshot" }]),
      );
    }
  } catch {
    /* ignore quota errors, same as stores.ts */
  }
  seedRepo(MOCK_REPO);
  mockWindows("main");
  mockIPC((cmd, args) => handleCommand(cmd, args), { shouldMockEvents: true });
  window.__trickshotMock = { send, emitEnvelope, notifications, sessionStarts };
}
