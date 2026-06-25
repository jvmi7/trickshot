import { derived, writable } from "svelte/store";
import type {
  ConnectorInfo,
  ModelInfo,
  PermissionMode,
  Repo,
  SlashCommandInfo,
  TranscriptMessage,
  TurnUsage,
  Worktree,
} from "./types";

export interface PermissionReq {
  id: string;
  tool: string;
  input: unknown;
}

/** A worktree's agent session lifecycle:
 *  - `ready`   — sidecar is alive and idle, awaiting input
 *  - `busy`    — a turn is in flight (set on send, cleared on the `result` message)
 *  - `stopped` — no live sidecar (never started, terminated, or errored) */
export type SessionStatus = "ready" | "busy" | "stopped";

const hasLS = typeof localStorage !== "undefined";

// ---- UI state ----
/** Whether the left sidebar is visible. Toggled from the global header. */
export const sidebarOpen = writable<boolean>(true);

/** What the center pane shows: the active chat, or the full Settings page.
 *  Ephemeral (always starts on `chat`). Set via `setCenterView`; selecting a
 *  worktree returns to `chat`, the sidebar-foot button opens `settings`. */
export type CenterView = "chat" | "settings";
export const centerView = writable<CenterView>("chat");
export function setCenterView(v: CenterView) {
  centerView.set(v);
}

/** Sidebar width in px (drag-to-resize), persisted and clamped to [MIN,MAX]. */
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 520;
const SIDEBAR_W_KEY = "trickshot.sidebarWidth";
function loadSidebarWidth(): number {
  if (!hasLS) return 320;
  const v = Number(localStorage.getItem(SIDEBAR_W_KEY));
  return Number.isFinite(v) && v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 320;
}
export const sidebarWidth = writable<number>(loadSidebarWidth());
sidebarWidth.subscribe((w) => {
  if (!hasLS) return;
  try {
    localStorage.setItem(SIDEBAR_W_KEY, String(w));
  } catch {
    /* ignore quota errors */
  }
});
/** Set the sidebar width, clamped to its allowed range (the drag handle's setter). */
export function setSidebarWidth(w: number) {
  sidebarWidth.set(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w))));
}

/** Which view the main pane shows for the selected worktree: the chat transcript
 *  or the git "changes" (diff) panel. Ephemeral UI state. */
export const mainView = writable<"chat" | "changes">("chat");

/** Bumped to ask an open GitPanel to re-fetch status/diff (e.g. after a turn that
 *  likely touched files). A monotonic counter the panel watches. */
export const gitRefreshNonce = writable<number>(0);
export function bumpGitRefresh() {
  gitRefreshNonce.update((n) => n + 1);
}

/** The chat's custom "scroll" position — a global cursor into the transcript.
 *  The chat pane never natively scrolls; `customScroll` drives this instead
 *  and the ScrollIndicator reflects it. `progress` is 0 (top) … 1 (bottom),
 *  `active` is true while the user is scrolling, `max` is the scrollable px. */
export const scrollCursor = writable<{ progress: number; active: boolean; max: number }>({
  progress: 0,
  active: false,
  max: 0,
});

// ---- Theme ----
export interface ThemeOption {
  id: string;
  label: string;
}
/** Selectable color themes. Each (except the default) overrides the `--base-*`
 *  palette under `[data-theme="<id>"]` in app.css. "terracotta" is the :root
 *  default and has no override block. To add a theme: add a `[data-theme]`
 *  block in app.css and an entry here — nothing else. See THEMING.md. */
export const THEMES: ThemeOption[] = [
  { id: "terracotta", label: "Terracotta" },
  { id: "ocean", label: "Ocean" },
  { id: "forest", label: "Forest" },
];
const THEME_KEY = "trickshot.theme";
function loadTheme(): string {
  const saved = hasLS ? localStorage.getItem(THEME_KEY) : null;
  return saved && THEMES.some((t) => t.id === saved) ? saved : "terracotta";
}
/** Active theme id. Reflects to `<html data-theme>` (which the `--base-*`
 *  override blocks key off) and persists to localStorage. */
export const theme = writable<string>(loadTheme());
theme.subscribe((t) => {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = t;
  if (!hasLS) return;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore quota errors */
  }
});

// ---- Persisted repos ----
const REPOS_KEY = "trickshot.repos";
function loadRepos(): Repo[] {
  if (!hasLS) return [];
  try {
    const v = JSON.parse(localStorage.getItem(REPOS_KEY) ?? "[]");
    return Array.isArray(v)
      ? v.filter((r) => r && typeof r.path === "string" && typeof r.name === "string")
      : [];
  } catch {
    return [];
  }
}
/** Repos added to the sidebar. Persisted to localStorage. */
export const repos = writable<Repo[]>(loadRepos());
repos.subscribe((r) => {
  if (!hasLS) return;
  try {
    localStorage.setItem(REPOS_KEY, JSON.stringify(r));
  } catch {
    /* ignore quota errors */
  }
});

/** Worktrees per repo path. Git is the source of truth — repopulated from
 *  `list_worktrees` on launch and after create/remove. */
export const worktreesByRepo = writable<Record<string, Worktree[]>>({});

// ---- Selection (persisted) ----
const SEL_KEY = "trickshot.selected";
export const selectedWorktree = writable<string | null>(
  (hasLS && localStorage.getItem(SEL_KEY)) || null,
);
selectedWorktree.subscribe((s) => {
  if (!hasLS) return;
  try {
    if (s) localStorage.setItem(SEL_KEY, s);
    else localStorage.removeItem(SEL_KEY);
  } catch {
    /* ignore */
  }
});

// ---- Per-worktree session status ----
export const sessionStatus = writable<Record<string, SessionStatus>>({});
export function setStatus(worktree: string, status: SessionStatus) {
  sessionStatus.update((m) => ({ ...m, [worktree]: status }));
}

// ---- Per-worktree agent activity (verbose loading state while a turn runs) ----
export interface AgentActivity {
  label: string; // current action, e.g. "Running command", "Thinking"
  detail: string; // its target, e.g. the command / file / query
  steps: number; // tool calls so far this turn
  startedAt: number; // ms, for the elapsed timer
}
export const worktreeActivity = writable<Record<string, AgentActivity>>({});
export function startActivity(worktree: string) {
  worktreeActivity.update((m) => ({
    ...m,
    [worktree]: { label: "Thinking", detail: "", steps: 0, startedAt: Date.now() },
  }));
}
export function setActivity(worktree: string, label: string, detail = "", bumpStep = false) {
  worktreeActivity.update((m) => {
    const cur = m[worktree] ?? { label, detail, steps: 0, startedAt: Date.now() };
    return { ...m, [worktree]: { ...cur, label, detail, steps: cur.steps + (bumpStep ? 1 : 0) } };
  });
}
export function clearActivity(worktree: string) {
  worktreeActivity.update((m) => {
    if (!(worktree in m)) return m;
    const next = { ...m };
    delete next[worktree];
    return next;
  });
}

// ---- Per-worktree last-completed-turn summary ("Cooked in 17s · 4 steps") ----
// Set on turn_end (App.svelte) and shown in the loading footer WHEN IDLE — it
// replaces the loading indicator and stays there until the next turn runs (the
// loading state takes precedence while busy, so it disappears as a turn starts).
// Ephemeral session state (not persisted).
export interface TurnSummary {
  seconds: number;
  steps: number;
}
export const turnSummary = writable<Record<string, TurnSummary>>({});
export function setTurnSummary(worktree: string, summary: TurnSummary) {
  turnSummary.update((m) => ({ ...m, [worktree]: summary }));
}

// ---- Models ----
// The switchable-model catalog is the same across worktrees (one Claude binary),
// so it's a single global list; the *current* model is per-worktree.
export const availableModels = writable<ModelInfo[]>([]);

// Available slash commands for the selected worktree's session (provider-supplied
// via the `commands` event). Global list; refreshed on session ready / get_commands.
export const availableCommands = writable<SlashCommandInfo[]>([]);

// Per-worktree current model, persisted so a chat's model choice is sticky across
// restarts. On a session's `models` event, App.svelte re-applies a persisted
// choice that differs from the sidecar default (see onModelsEvent there).
const MODELS_KEY = "trickshot.modelByWorktree";
function loadModelByWorktree(): Record<string, string> {
  if (!hasLS) return {};
  try {
    const v = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
export const modelByWorktree = writable<Record<string, string>>(loadModelByWorktree());
modelByWorktree.subscribe((m) => {
  if (!hasLS) return;
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify(m));
  } catch {
    /* ignore quota errors */
  }
});
export function setWorktreeModel(worktree: string, model: string) {
  modelByWorktree.update((m) => ({ ...m, [worktree]: model }));
}

// ---- Connectors (MCP servers) ----
// Live, per-worktree connector list as last reported by that session's
// `connectors` event (ephemeral — re-fetched each session, not persisted).
export const connectorsByWorktree = writable<Record<string, ConnectorInfo[]>>({});
export function setConnectors(worktree: string, servers: ConnectorInfo[]) {
  connectorsByWorktree.update((m) => ({ ...m, [worktree]: servers }));
}

// trickshot's OWN connector enable/disable preferences — GLOBAL (one set for
// every repo/session). The SDK's `toggleMcpServer` is a LIVE control it does not
// remember across sessions, so we persist the preference here and re-apply it on
// each session's `connectors` event (see App.svelte). `undefined` for a connector
// = leave it at the SDK's own default. Persisted via the standard template.
const CONN_GLOBAL_KEY = "trickshot.connectorPrefs.global";
function loadBoolMap(key: string): Record<string, boolean> {
  if (!hasLS) return {};
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
/** Global connector enable/disable preferences (connector name → enabled). */
export const globalConnectorPrefs = writable<Record<string, boolean>>(loadBoolMap(CONN_GLOBAL_KEY));
globalConnectorPrefs.subscribe((m) => {
  if (!hasLS) return;
  try {
    localStorage.setItem(CONN_GLOBAL_KEY, JSON.stringify(m));
  } catch {
    /* ignore quota errors */
  }
});
export function setGlobalConnectorPref(name: string, enabled: boolean) {
  globalConnectorPrefs.update((m) => ({ ...m, [name]: enabled }));
}

// ---- Per-worktree cost + token usage (accumulated per turn, persisted) ----
// Each `turn_end` carries the turn's token/cost figures (see TurnUsage); we sum
// them per worktree for a running session total. `costUsd` is a client-side
// estimate (per the SDK), surfaced as such in the UI.
export interface WorktreeCost {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
}
const ZERO_COST: WorktreeCost = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};
const COST_KEY = "trickshot.costByWorktree";
function loadCostByWorktree(): Record<string, WorktreeCost> {
  if (!hasLS) return {};
  try {
    const v = JSON.parse(localStorage.getItem(COST_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
export const costByWorktree = writable<Record<string, WorktreeCost>>(loadCostByWorktree());
costByWorktree.subscribe((c) => {
  if (!hasLS) return;
  try {
    localStorage.setItem(COST_KEY, JSON.stringify(c));
  } catch {
    /* ignore quota errors */
  }
});
/** Fold one turn's usage into a worktree's running total (missing fields count
 *  as zero, so a provider that omits a figure simply doesn't move it). */
export function addTurnCost(worktree: string, usage: TurnUsage) {
  costByWorktree.update((c) => {
    const cur = c[worktree] ?? ZERO_COST;
    return {
      ...c,
      [worktree]: {
        costUsd: cur.costUsd + (usage.costUsd ?? 0),
        inputTokens: cur.inputTokens + (usage.inputTokens ?? 0),
        outputTokens: cur.outputTokens + (usage.outputTokens ?? 0),
        cacheReadTokens: cur.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheCreationTokens: cur.cacheCreationTokens + (usage.cacheCreationTokens ?? 0),
        turns: cur.turns + 1,
      },
    };
  });
}

// ---- Per-worktree permission mode (persisted) ----
// Controls how the agent's tool use is gated. `bypassPermissions` (the historical
// default) runs every tool silently; the others route tool use through the
// Allow/Deny modal. Applied at session start (PERMISSION_MODE env) and switched
// live via the `set_permission_mode` command.
const PERM_MODE_KEY = "trickshot.permissionModeByWorktree";
const PERMISSION_MODES: PermissionMode[] = ["bypassPermissions", "acceptEdits", "default", "plan"];
function loadPermissionModeByWorktree(): Record<string, PermissionMode> {
  if (!hasLS) return {};
  try {
    const v = JSON.parse(localStorage.getItem(PERM_MODE_KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, PermissionMode> = {};
    for (const [k, mode] of Object.entries(v)) {
      if (PERMISSION_MODES.includes(mode as PermissionMode)) out[k] = mode as PermissionMode;
    }
    return out;
  } catch {
    return {};
  }
}
export const permissionModeByWorktree = writable<Record<string, PermissionMode>>(
  loadPermissionModeByWorktree(),
);
permissionModeByWorktree.subscribe((m) => {
  if (!hasLS) return;
  try {
    localStorage.setItem(PERM_MODE_KEY, JSON.stringify(m));
  } catch {
    /* ignore quota errors */
  }
});
export function setWorktreePermissionMode(worktree: string, mode: PermissionMode) {
  permissionModeByWorktree.update((m) => ({ ...m, [worktree]: mode }));
}

// ---- Font ----
export interface FontOption {
  id: string;
  label: string;
}
/** Selectable UI fonts. Each overrides `--app-font` under `[data-font="<id>"]`
 *  in app.css; "sans-code" is the :root default (no block). To add a font: add
 *  its @font-face + a `[data-font]` block in app.css and an entry here. */
export const FONTS: FontOption[] = [
  { id: "sans-code", label: "Sans Code" },
  { id: "wenkai", label: "WenKai Mono" },
  { id: "comic", label: "Comic Sans" },
  { id: "ibm", label: "IBM Plex Mono" },
  { id: "helvetica", label: "Helvetica" },
];
const FONT_KEY = "trickshot.font";
function loadFont(): string {
  const saved = hasLS ? localStorage.getItem(FONT_KEY) : null;
  return saved && FONTS.some((f) => f.id === saved) ? saved : "sans-code";
}
/** Active font id. Reflects to `<html data-font>` and persists. */
export const font = writable<string>(loadFont());
font.subscribe((f) => {
  if (typeof document !== "undefined") document.documentElement.dataset.font = f;
  if (!hasLS) return;
  try {
    localStorage.setItem(FONT_KEY, f);
  } catch {
    /* ignore quota errors */
  }
});

// ---- Custom system-prompt append (global, persisted) ----
// Appended to the `claude_code` preset system prompt at session start (applies to
// NEW sessions; existing ones need a restart). Empty = no append.
const SYS_PROMPT_KEY = "trickshot.systemPromptAppend";
function loadSystemPromptAppend(): string {
  if (!hasLS) return "";
  const v = localStorage.getItem(SYS_PROMPT_KEY);
  return typeof v === "string" ? v : "";
}
export const systemPromptAppend = writable<string>(loadSystemPromptAppend());
systemPromptAppend.subscribe((s) => {
  if (!hasLS) return;
  try {
    localStorage.setItem(SYS_PROMPT_KEY, s);
  } catch {
    /* ignore quota errors */
  }
});

// ---- Per-worktree agent session id (for resume) ----
// The SDK reports a session_id on every message; we persist the latest per
// worktree so `start_session` can resume it after a restart — restoring the
// agent's *context*. (Resume does NOT replay messages, so the *visible* history
// is restored separately by persisting the transcript below.)
const SESSION_KEY = "trickshot.sessionByWorktree";
function loadSessionByWorktree(): Record<string, string> {
  if (!hasLS) return {};
  try {
    const v = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
export const sessionByWorktree = writable<Record<string, string>>(loadSessionByWorktree());
sessionByWorktree.subscribe((m) => {
  if (!hasLS) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(m));
  } catch {
    /* ignore quota errors */
  }
});
export function setWorktreeSession(worktree: string, id: string) {
  sessionByWorktree.update((m) => (m[worktree] === id ? m : { ...m, [worktree]: id }));
}
/** Forget a worktree's persisted session + transcript (e.g. on worktree removal,
 *  so a recreated worktree at the same path starts clean). */
export function forgetWorktreeSession(worktree: string) {
  sessionByWorktree.update((m) => {
    if (!(worktree in m)) return m;
    const next = { ...m };
    delete next[worktree];
    return next;
  });
}

// ---- Per-worktree transcripts (batched appends, persisted) ----
// A burst of streamed lines coalesces into one store write per 16ms across all
// worktrees. Each message gets a stable `__key` for identity-keyed {#each}.
// Transcripts persist to localStorage so chat history survives restarts (resume
// restores agent context but not the rendered messages — see above).
// `.v2` because the persisted message shape changed (raw SDK messages -> the
// neutral AgentMessage schema). Bumping the key drops pre-v2 transcripts on
// upgrade rather than rendering them blank; resume still restores agent context.
const TRANSCRIPTS_KEY = "trickshot.transcripts.v2";
function loadTranscripts(): Record<string, TranscriptMessage[]> {
  if (!hasLS) return {};
  try {
    const v = JSON.parse(localStorage.getItem(TRANSCRIPTS_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
const _loaded = loadTranscripts();
export const transcripts = writable<Record<string, TranscriptMessage[]>>(_loaded);

// Continue keys above any rehydrated __key so identity-keyed {#each} stays unique
// (the counter resets to 0 on reload, which would otherwise collide).
let _key = 0;
for (const list of Object.values(_loaded)) {
  for (const m of list) {
    const k = (m as { __key?: number }).__key;
    if (typeof k === "number" && k >= _key) _key = k + 1;
  }
}

// Persist on idle (debounced, reset on each change) so we never serialize the
// whole map mid-stream — only ~600ms after a burst settles.
if (hasLS) {
  let _latest = _loaded;
  let _saveTimer: ReturnType<typeof setTimeout> | null = null;
  transcripts.subscribe((t) => {
    _latest = t;
    if (_saveTimer !== null) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      try {
        localStorage.setItem(TRANSCRIPTS_KEY, JSON.stringify(_latest));
      } catch {
        /* ignore quota errors — history just won't persist past the limit */
      }
    }, 600);
  });
}

const _buffers: Record<string, TranscriptMessage[]> = {};
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  _flushTimer = null;
  const keys = Object.keys(_buffers);
  if (keys.length === 0) return;
  transcripts.update((t) => {
    const next = { ...t };
    for (const k of keys) {
      const batch = _buffers[k];
      if (!batch) continue;
      next[k] = (next[k] ?? []).concat(batch);
      delete _buffers[k];
    }
    return next;
  });
}

/** Append a message to a worktree's transcript (stable key + batched write). */
export function appendMessage(worktree: string, msg: TranscriptMessage) {
  (msg as { __key?: number }).__key = _key++;
  (_buffers[worktree] ??= []).push(msg);
  if (_flushTimer === null) _flushTimer = setTimeout(flush, 16);
}

/** Clear a worktree's transcript and drop any buffered (un-flushed) messages. */
export function resetTranscript(worktree: string) {
  delete _buffers[worktree];
  transcripts.update((t) => ({ ...t, [worktree]: [] }));
}

/** Attach a rewind checkpoint id to the most recent `user_local` turn that
 *  doesn't have one yet (the turn the agent just echoed). No-op if none found.
 *  Checks the un-flushed buffer first, then the store. */
export function attachRewindId(worktree: string, id: string) {
  const buf = _buffers[worktree];
  if (buf) {
    for (let i = buf.length - 1; i >= 0; i--) {
      const m = buf[i];
      if (m && m.type === "user_local" && !m.rewindId) {
        m.rewindId = id;
        return;
      }
    }
  }
  transcripts.update((t) => {
    const list = t[worktree];
    if (!list) return t;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.type === "user_local" && !m.rewindId) {
        const next = list.slice();
        next[i] = { ...m, rewindId: id };
        return { ...t, [worktree]: next };
      }
    }
    return t;
  });
}

// ---- Per-worktree pending permission (dormant under bypassPermissions) ----
export const pendingPermission = writable<Record<string, PermissionReq | null>>({});

// ---- Derived views for the currently selected worktree ----
export const activeMessages = derived([transcripts, selectedWorktree], ([$t, $sel]) =>
  $sel ? ($t[$sel] ?? []) : [],
);

/** tool_call id → its result, from the selected transcript. Lets a tool_call row
 *  fold in its result (the merged one-line tool rendering); the standalone
 *  tool_result bubble is then suppressed in Message.svelte. Derived over the full
 *  active transcript (same O(total) order as the per-flush copy already done each
 *  burst — see CLAUDE.md PERFORMANCE), not the window, so a call always finds its
 *  result even when it sits near the window edge. */
export const toolResultsById = derived(activeMessages, ($m) => {
  const map: Record<string, { content: string; isError: boolean }> = {};
  for (const msg of $m) {
    if (msg.type === "tool_result") map[msg.id] = { content: msg.content, isError: !!msg.isError };
  }
  return map;
});

// ---- Transcript windowing (bound the DOM) ----
// A transcript only grows (except on resetTranscript), and naive full-mount tops
// out at ~hundreds of messages (see CLAUDE.md PERFORMANCE). Chat mounts only the
// newest RENDER_WINDOW messages; older ones stay in the persisted transcript but
// out of the DOM. Identity-keyed `{#each}` means windowing just drops the top
// node and adds a bottom one per append. Measure before raising this.
export const RENDER_WINDOW = 300;

/** The newest `RENDER_WINDOW` messages of the selected transcript — what Chat
 *  actually mounts. Same object identities as `activeMessages` (a tail slice),
 *  so `__key` keying stays stable. */
export const renderedMessages = derived(activeMessages, ($m) =>
  $m.length > RENDER_WINDOW ? $m.slice(-RENDER_WINDOW) : $m,
);

/** How many older messages sit above the render window (0 when nothing hidden). */
export const hiddenMessageCount = derived(activeMessages, ($m) =>
  Math.max(0, $m.length - RENDER_WINDOW),
);

// ---- Tool-call grouping (batch consecutive tool activity) ----
// A turn can fire dozens of tool calls; rendering one row each spams the chat.
// We bundle a maximal RUN of tool messages (tool_call + tool_result, no prose in
// between) into one collapsible group (see ToolGroup.svelte). `tool_result`s are
// folded into their call (toolResultsById) and don't render, but they DON'T break
// a run. Everything else (assistant/user_local/system/error) is its own group.
type ToolCallMsg = Extract<TranscriptMessage, { type: "tool_call" }>;
export type RenderedGroup =
  | { kind: "single"; key: string; message: TranscriptMessage }
  | { kind: "tools"; key: string; tools: ToolCallMsg[] };

/** `renderedMessages` collapsed into render groups. Keyed stably by the first
 *  member's `__key` (prefixed) so identity-keyed `{#each}` reconciles efficiently:
 *  appending a tool call grows the open run's array (same group key), and the
 *  group's own `{#each tools (__key)}` adds just the new row. */
export const renderedGroups = derived(renderedMessages, ($msgs): RenderedGroup[] => {
  const groups: RenderedGroup[] = [];
  let run: { kind: "tools"; key: string; tools: ToolCallMsg[] } | null = null;
  for (const m of $msgs) {
    if (m.type === "tool_call") {
      if (!run) {
        run = { kind: "tools", key: `g${m.__key}`, tools: [] };
        groups.push(run);
      }
      run.tools.push(m);
    } else if (m.type === "tool_result") {
      // Folded into its call (renders nothing); does not break the current run.
    } else {
      run = null;
      groups.push({ kind: "single", key: `m${m.__key}`, message: m });
    }
  }
  return groups;
});
export const activePending = derived([pendingPermission, selectedWorktree], ([$p, $sel]) =>
  $sel ? ($p[$sel] ?? null) : null,
);
/** The current model of the selected worktree's chat (null until its session
 *  reports a `models` event). */
export const activeModel = derived([modelByWorktree, selectedWorktree], ([$m, $sel]) =>
  $sel ? ($m[$sel] ?? null) : null,
);
/** The selected worktree's current agent activity (null when idle). */
export const activeActivity = derived([worktreeActivity, selectedWorktree], ([$a, $sel]) =>
  $sel ? ($a[$sel] ?? null) : null,
);
/** The selected worktree's last-completed-turn summary (null until a turn ends). */
export const activeSummary = derived([turnSummary, selectedWorktree], ([$s, $sel]) =>
  $sel ? ($s[$sel] ?? null) : null,
);
/** The selected worktree's running cost/token total (null until a turn completes). */
export const activeCost = derived([costByWorktree, selectedWorktree], ([$c, $sel]) =>
  $sel ? ($c[$sel] ?? null) : null,
);
/** The session default when a worktree has no explicit choice — preserves the
 *  historical silent-run behavior so enabling prompts is opt-in. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";
export { PERMISSION_MODES };
/** The selected worktree's permission mode (falls back to the default). */
export const activePermissionMode = derived(
  [permissionModeByWorktree, selectedWorktree],
  ([$m, $sel]) => ($sel ? ($m[$sel] ?? DEFAULT_PERMISSION_MODE) : DEFAULT_PERMISSION_MODE),
);
