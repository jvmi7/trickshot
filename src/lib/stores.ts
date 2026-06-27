import { derived, get, type Readable, type Writable, writable } from "svelte/store";
import * as api from "./api";
import { DEFAULT_THEME, THEMES as THEME_DEFS } from "./themes";
import {
  appendMessage,
  bufferedMessages,
  groupMessages,
  hiddenCount,
  indexToolResults,
  resetTranscript,
  summarizeConversation,
  transcripts,
  windowTail,
} from "./transcript";
import type {
  ConnectorInfo,
  McpStatusInfo,
  ModelInfo,
  PermissionMode,
  Question,
  Repo,
  SlashCommandInfo,
  UsageInfo,
  Worktree,
} from "./types";

export interface PermissionReq {
  id: string;
  tool: string;
  input: unknown;
}

/** A pending `ask_user` question for a worktree (answered via QuestionModal). */
export interface QuestionReq {
  id: string;
  questions: Question[];
}

/** A worktree's agent session lifecycle:
 *  - `ready`   — sidecar is alive and idle, awaiting input
 *  - `busy`    — a turn is in flight (set on send, cleared on the `result` message)
 *  - `stopped` — no live sidecar (never started, terminated, or errored) */
export type SessionStatus = "ready" | "busy" | "stopped";

const hasLS = typeof localStorage !== "undefined";

// ---- Persistence primitive (the ONE template) ----
// A localStorage-backed writable: load() with a shape guard + fallback, then a
// subscribe() write-back that swallows quota errors, under a `trickshot.<name>`
// key. Every persisted store below is built from this — the guard/quota invariant
// is structural here instead of hand-copied per store (see CLAUDE.md). `parse`
// turns the stored string into T and MAY throw or return the fallback for bad
// data (load() catches and falls back); `serialize` defaults to JSON.
function createPersisted<T>(
  key: string,
  fallback: T,
  opts: { parse?: (raw: string) => T; serialize?: (value: T) => string } = {},
): Writable<T> {
  const serialize = opts.serialize ?? ((v: T) => JSON.stringify(v));
  const parse = opts.parse ?? ((raw: string) => JSON.parse(raw) as T);
  const load = (): T => {
    if (!hasLS) return fallback;
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    try {
      return parse(raw);
    } catch {
      return fallback;
    }
  };
  const store = writable<T>(load());
  store.subscribe((v) => {
    if (!hasLS) return;
    try {
      localStorage.setItem(key, serialize(v));
    } catch {
      /* ignore quota errors */
    }
  });
  return store;
}

/** A persisted store of a raw string (identity parse/serialize) — the JSON
 *  helpers' string counterpart. Optional `validate` clamps a stored value to a
 *  known set (e.g. theme/font ids), falling back when it doesn't match. */
function createPersistedString(
  key: string,
  fallback = "",
  validate?: (raw: string) => string,
): Writable<string> {
  return createPersisted<string>(key, fallback, {
    parse: validate ?? ((raw) => raw),
    serialize: (v) => v,
  });
}

/** The shape guard shared by every "is this a plain JSON object?" check
 *  (object, not null, not array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** `createPersisted` parse fn for "a JSON object map of V" with the standard
 *  shape guard. Anything else → the empty map. */
function parseJsonObject<V>(raw: string): Record<string, V> {
  const v = JSON.parse(raw);
  return isPlainObject(v) ? (v as Record<string, V>) : {};
}

/** Parse a free-text JSON config blob (MCP servers / agent defs) into an object,
 *  or undefined if empty/invalid. The single parser behind getMcpServers/getAgents. */
function parseConfigBlob(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const v = JSON.parse(trimmed);
    return isPlainObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// ---- Per-worktree map primitive (the ONE template for per-worktree state) ----
/** A store keyed by worktree path, plus the standard `set`/`remove` mutators and
 *  an `active(fallback)` derived (the SELECTED worktree's value, or the fallback).
 *  The app is built from ~a dozen of these `writable<Record<string,T>>` + setter +
 *  `active*` derived triples; this collapses them into one shape so adding
 *  per-worktree state is a single call, not a re-derived trio (CLAUDE.md). Pass
 *  `persistKey` to back it with the persisted template; mutators that need custom
 *  logic (merge, no-op guard, +1) build on `.store`/`.update` instead of `.set`. */
interface WorktreeMap<T> {
  store: Writable<Record<string, T>>;
  /** Set a worktree's value (replaces). */
  set(worktree: string, value: T): void;
  /** Update a worktree's value via an updater that receives the current value
   *  (`undefined` when absent) — the basis for custom mutators. */
  update(worktree: string, fn: (cur: T | undefined) => T): void;
  /** Drop a worktree's entry entirely (no-op, same identity, when absent). */
  remove(worktree: string): void;
  /** Derived view of the selected worktree's value, or `fallback` when none. */
  active<F>(fallback: F): Readable<T | F>;
}
function createWorktreeMap<T>(
  opts: { persistKey?: string; parse?: (raw: string) => Record<string, T> } = {},
): WorktreeMap<T> {
  const store = opts.persistKey
    ? createPersisted<Record<string, T>>(
        opts.persistKey,
        {},
        { parse: opts.parse ?? parseJsonObject },
      )
    : writable<Record<string, T>>({});
  return {
    store,
    set: (worktree, value) => store.update((m) => ({ ...m, [worktree]: value })),
    update: (worktree, fn) => store.update((m) => ({ ...m, [worktree]: fn(m[worktree]) })),
    remove: (worktree) =>
      store.update((m) => {
        if (!(worktree in m)) return m;
        const next = { ...m };
        delete next[worktree];
        return next;
      }),
    active: (fallback) =>
      derived([store, selectedWorktree], ([$m, $sel]) =>
        $sel ? ($m[$sel] ?? fallback) : fallback,
      ),
  };
}

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
export const sidebarWidth = createPersisted<number>("trickshot.sidebarWidth", 320, {
  parse: (raw) => {
    const v = Number(raw);
    return Number.isFinite(v) && v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 320;
  },
  serialize: (v) => String(v),
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

/** Per-worktree change summary (changed-file count + diffstat). Populated by
 *  App.svelte from `worktree_status` on selection / gitRefreshNonce; drives the
 *  header's Changes tab — shown only when `changed > 0`, with the +/- counts. */
export interface GitStat {
  changed: number;
  insertions: number;
  deletions: number;
}
const _gitStat = createWorktreeMap<GitStat>();
export const gitStatByWorktree = _gitStat.store;
export const setGitStat = _gitStat.set;

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
/** Selectable color themes — DERIVED from the single theme config (`themes.ts`).
 *  To add/remove a theme, edit `THEMES` there; this list (and the injected CSS)
 *  follow automatically. See THEMING.md. */
export const THEMES: ThemeOption[] = THEME_DEFS.map((t) => ({ id: t.id, label: t.label }));
/** Active theme id. Reflects to `<html data-theme>` (which the `--base-*`
 *  override blocks key off) and persists to localStorage. */
export const theme = createPersistedString("trickshot.theme", DEFAULT_THEME, (raw) =>
  THEMES.some((t) => t.id === raw) ? raw : DEFAULT_THEME,
);
theme.subscribe((t) => {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = t;
});
/** Switch the active theme (validated against THEMES by the store's parse). */
export function setTheme(id: string) {
  theme.set(id);
}

// ---- Persisted repos ----
/** Repos added to the sidebar. Persisted to localStorage. */
export const repos = createPersisted<Repo[]>("trickshot.repos", [], {
  parse: (raw) => {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((r) => r && typeof r.path === "string" && typeof r.name === "string")
      : [];
  },
});
/** Add a repo to the sidebar (de-duplicated by path). */
export function addRepo(repo: Repo) {
  repos.update((rs) => (rs.some((r) => r.path === repo.path) ? rs : [...rs, repo]));
}

/** Worktrees per repo path. Git is the source of truth — repopulated from
 *  `list_worktrees` on launch and after create/remove. */
export const worktreesByRepo = writable<Record<string, Worktree[]>>({});
/** Replace the worktree list for one repo path. */
export function setWorktrees(repoPath: string, list: Worktree[]) {
  worktreesByRepo.update((m) => ({ ...m, [repoPath]: list }));
}
/** Append one worktree to a repo's list. */
export function addWorktree(repoPath: string, wt: Worktree) {
  worktreesByRepo.update((m) => ({ ...m, [repoPath]: [...(m[repoPath] ?? []), wt] }));
}
/** Remove a worktree (by path) from a repo's list. */
export function removeWorktreeFromRepo(repoPath: string, worktreePath: string) {
  worktreesByRepo.update((m) => ({
    ...m,
    [repoPath]: (m[repoPath] ?? []).filter((w) => w.path !== worktreePath),
  }));
}

// ---- Selection (persisted) ----
// Routed through the standard persisted template like every other persisted store;
// an empty string round-trips as "no selection" (`null`), the template's stand-in
// for the old removeItem.
export const selectedWorktree = createPersisted<string | null>("trickshot.selected", null, {
  parse: (raw) => raw || null,
  serialize: (v) => v ?? "",
});

// ---- Per-worktree session status ----
const _status = createWorktreeMap<SessionStatus>();
export const sessionStatus = _status.store;
export const setStatus = _status.set;
/** Drop a worktree's status entry entirely (e.g. on removal). */
export const clearStatus = _status.remove;

// ---- Per-worktree unread activity (turns completed while not selected) ----
// Drives a sidebar badge so background agents that finished are visible at a
// glance. Bumped on a backgrounded `turn_end`; cleared when the worktree is opened.
const _unread = createWorktreeMap<number>();
export const unreadByWorktree = _unread.store;
export function bumpUnread(worktree: string) {
  _unread.update(worktree, (n) => (n ?? 0) + 1);
}
export function clearUnread(worktree: string) {
  // Set to 0 (not remove) and skip the write when already cleared — returning the
  // same map identity fires no subscribers.
  _unread.store.update((m) => (m[worktree] ? { ...m, [worktree]: 0 } : m));
}

// ---- Per-worktree agent activity (verbose loading state while a turn runs) ----
export interface AgentActivity {
  label: string; // current action, e.g. "Running command", "Thinking"
  detail: string; // its target, e.g. the command / file / query
  steps: number; // tool calls so far this turn
  startedAt: number; // ms, for the elapsed timer
}
const _activity = createWorktreeMap<AgentActivity>();
export const worktreeActivity = _activity.store;
export function startActivity(worktree: string) {
  _activity.set(worktree, { label: "Thinking", detail: "", steps: 0, startedAt: Date.now() });
}
export function setActivity(worktree: string, label: string, detail = "", bumpStep = false) {
  _activity.store.update((m) => {
    const cur = m[worktree] ?? { label, detail, steps: 0, startedAt: Date.now() };
    // Skip a no-op write (same label/detail, no step bump): returning the same map
    // identity fires no subscribers — mirrors the remove() early-return guard.
    if (worktree in m && cur.label === label && cur.detail === detail && !bumpStep) return m;
    return { ...m, [worktree]: { ...cur, label, detail, steps: cur.steps + (bumpStep ? 1 : 0) } };
  });
}
export const clearActivity = _activity.remove;

// ---- Per-worktree last-completed-turn summary ("Cooked in 17s · 4 steps") ----
// Set on turn_end (App.svelte) and shown in the loading footer WHEN IDLE — it
// replaces the loading indicator and stays there until the next turn runs (the
// loading state takes precedence while busy, so it disappears as a turn starts).
// Ephemeral session state (not persisted).
export interface TurnSummary {
  seconds: number;
  steps: number;
}
const _summary = createWorktreeMap<TurnSummary>();
export const turnSummary = _summary.store;
export const setTurnSummary = _summary.set;

// ---- Models ----
// The switchable-model catalog is the same across worktrees (one Claude binary),
// so it's a single global list; the *current* model is per-worktree.
export const availableModels = writable<ModelInfo[]>([]);
export function setAvailableModels(models: ModelInfo[]) {
  availableModels.set(models);
}

// Available slash commands for the selected worktree's session (provider-supplied
// via the `commands` event). Global list; refreshed on session ready / get_commands.
export const availableCommands = writable<SlashCommandInfo[]>([]);
export function setAvailableCommands(commands: SlashCommandInfo[]) {
  availableCommands.set(commands);
}

// ---- MCP integrations ----
// MCP server config is a JSON object (same shape as `.mcp.json`'s `mcpServers`),
// edited as raw JSON in Settings and applied at session start / live. Persisted.
export const mcpServersJson = createPersistedString("trickshot.mcpServersJson");
/** Parse the saved MCP JSON into a config object, or undefined if empty/invalid. */
export function getMcpServers(): Record<string, unknown> | undefined {
  return parseConfigBlob(get(mcpServersJson));
}
/** Latest MCP server statuses for the selected session (via the `mcp_status` event). */
export const mcpStatus = writable<McpStatusInfo[]>([]);
export function setMcpStatus(servers: McpStatusInfo[]) {
  mcpStatus.set(servers);
}

// ---- Subagent definitions ----
// Optional user-defined subagents as JSON (Record<name, {description, prompt,
// model?, tools?, ...}>), edited in Settings and applied at session start.
// Repo `.claude/agents` are also loaded automatically via settingSources.
export const agentsJson = createPersistedString("trickshot.agentsJson");
/** Parse the saved subagents JSON into a config object, or undefined if empty/invalid. */
export function getAgents(): Record<string, unknown> | undefined {
  return parseConfigBlob(get(agentsJson));
}

// Per-worktree current model, persisted so a chat's model choice is sticky across
// restarts. On a session's `models` event, App.svelte re-applies a persisted
// choice that differs from the sidecar default (see onModelsEvent there).
const _model = createWorktreeMap<string>({ persistKey: "trickshot.modelByWorktree" });
export const modelByWorktree = _model.store;
export const setWorktreeModel = _model.set;

// ---- Connectors (MCP servers) ----
// Live, per-worktree connector list as last reported by that session's
// `connectors` event (ephemeral — re-fetched each session, not persisted).
const _connectors = createWorktreeMap<ConnectorInfo[]>();
export const connectorsByWorktree = _connectors.store;
export const setConnectors = _connectors.set;

// trickshot's OWN connector enable/disable preferences — GLOBAL (one set for
// every repo/session). The SDK's `toggleMcpServer` is a LIVE control it does not
// remember across sessions, so we persist the preference here and re-apply it on
// each session's `connectors` event (see App.svelte). `undefined` for a connector
// = leave it at the SDK's own default. Persisted via the standard template.
/** Global connector enable/disable preferences (connector name → enabled). */
export const globalConnectorPrefs = createPersisted<Record<string, boolean>>(
  "trickshot.connectorPrefs.global",
  {},
  { parse: parseJsonObject },
);
export function setGlobalConnectorPref(name: string, enabled: boolean) {
  globalConnectorPrefs.update((m) => ({ ...m, [name]: enabled }));
}

// ---- Subscription usage windows (account-global, throttled fetch) ----
// The rolling ~5-hour session window + the weekly window from `get_usage` (the
// undocumented /usage endpoint). Account-wide, NOT per-worktree. The endpoint is
// aggressively rate-limited, so `refreshUsage()` is event-driven (session start,
// turn end) and throttled to at most once per USAGE_REFRESH_MS — never polled.
// The last value is persisted so the chip shows immediately (cached) on launch.
const USAGE_REFRESH_MS = 90_000;
export const usageLimits = createPersisted<UsageInfo | null>("trickshot.usageLimits", null, {
  parse: (raw) => {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as UsageInfo) : null;
  },
});
/** Last fetch error (stale token, rate limit, offline), shown in the tooltip. */
export const usageError = writable<string | null>(null);

let usageLastFetch = 0;
let usageInFlight = false;
/** Refresh the usage windows, throttled. `force` bypasses the interval (e.g. a
 *  manual refresh) but never overlaps an in-flight request. Failures land in
 *  `usageError` and leave the last good value in place — the endpoint is best
 *  effort, so a transient 429/401 must not blank the chip. */
export async function refreshUsage(force = false) {
  if (usageInFlight) return;
  if (!force && Date.now() - usageLastFetch < USAGE_REFRESH_MS) return;
  usageInFlight = true;
  try {
    usageLimits.set(await api.getUsage());
    usageError.set(null);
    usageLastFetch = Date.now();
  } catch (e) {
    usageError.set(e instanceof Error ? e.message : String(e));
  } finally {
    usageInFlight = false;
  }
}

// ---- Per-worktree permission mode (persisted) ----
// Controls how the agent's tool use is gated. `bypassPermissions` (the historical
// default) runs every tool silently; the others route tool use through the
// Allow/Deny modal. Applied at session start (PERMISSION_MODE env) and switched
// live via the `set_permission_mode` command.
const PERMISSION_MODES: PermissionMode[] = ["bypassPermissions", "acceptEdits", "default", "plan"];
const _permMode = createWorktreeMap<PermissionMode>({
  persistKey: "trickshot.permissionModeByWorktree",
  // Drop any stored value outside the known mode set (shape guard for the template).
  parse: (raw) => {
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) return {};
    const out: Record<string, PermissionMode> = {};
    for (const [k, mode] of Object.entries(v)) {
      if (PERMISSION_MODES.includes(mode as PermissionMode)) out[k] = mode as PermissionMode;
    }
    return out;
  },
});
export const permissionModeByWorktree = _permMode.store;
export const setWorktreePermissionMode = _permMode.set;

// ---- Suggested replies (per-worktree, ephemeral; NOT persisted) ----
// Short "what to send next" options the agent generates after a turn (see the
// `suggest`/`suggestions` protocol kinds). Cleared when the user sends anything.
const _suggestions = createWorktreeMap<string[]>();
export const suggestionsByWorktree = _suggestions.store;
export const setSuggestions = _suggestions.set;
export function clearSuggestions(worktree: string) {
  // Skip the write when already empty — same map identity fires no subscribers.
  _suggestions.store.update((s) => (s[worktree]?.length ? { ...s, [worktree]: [] } : s));
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
  { id: "geist", label: "Geist" },
  { id: "mulish", label: "Mulish" },
  { id: "lexend", label: "Lexend" },
  { id: "nunito", label: "Nunito" },
  { id: "sn-pro", label: "SN Pro" },
];
/** Active font id. Reflects to `<html data-font>` and persists. */
export const font = createPersistedString("trickshot.font", "sans-code", (raw) =>
  FONTS.some((f) => f.id === raw) ? raw : "sans-code",
);
font.subscribe((f) => {
  if (typeof document !== "undefined") document.documentElement.dataset.font = f;
});
/** Switch the active font (validated against FONTS by the store's parse). */
export function setFont(id: string) {
  font.set(id);
}

// ---- Custom system-prompt append (global, persisted) ----
// Appended to the `claude_code` preset system prompt at session start (applies to
// NEW sessions; existing ones need a restart). Empty = no append.
export const systemPromptAppend = createPersistedString("trickshot.systemPromptAppend");

// ---- Per-worktree agent session id (for resume) ----
// The SDK reports a session_id on every message; we persist the latest per
// worktree so `start_session` can resume it after a restart — restoring the
// agent's *context*. (Resume does NOT replay messages, so the *visible* history
// is restored separately by persisting the transcript below.)
const _session = createWorktreeMap<string>({ persistKey: "trickshot.sessionByWorktree" });
export const sessionByWorktree = _session.store;
export function setWorktreeSession(worktree: string, id: string) {
  // Skip the write when the id is unchanged — same map identity fires no subscribers.
  _session.store.update((m) => (m[worktree] === id ? m : { ...m, [worktree]: id }));
}
/** Forget a worktree's persisted session + transcript (e.g. on worktree removal,
 *  so a recreated worktree at the same path starts clean). */
export const forgetWorktreeSession = _session.remove;

// ---- Per-worktree transcripts ----
// The batching / persistence / windowing / grouping engine lives in
// `transcript.ts` (a self-contained subsystem with its own invariants); re-export
// the mutators so `import { appendMessage } from "./stores"` keeps working and
// transcript writes still have ONE home (see CLAUDE.md).
export { appendMessage, resetTranscript, transcripts };

/** Send a user turn to a worktree's agent: optimistically render the `user_local`
 *  bubble, mark the session busy, clear any stale suggestions, then fire the IPC
 *  (unsticking the UI if it's rejected). The ONE place a user turn is submitted —
 *  the Composer and the suggestion chips both route through here. Callers guard
 *  against sending while busy / with empty text. */
export async function submitUserTurn(worktree: string, text: string) {
  const t = text.trim();
  if (!t) return;
  appendMessage(worktree, { type: "user_local", text: t });
  setStatus(worktree, "busy");
  startActivity(worktree);
  clearSuggestions(worktree);
  try {
    await api.sendUserTurn(worktree, t);
  } catch (e) {
    appendMessage(worktree, { type: "error", error: `failed to send: ${e}` });
    setStatus(worktree, "ready");
    clearActivity(worktree);
  }
}

/** Start (or no-op, if already running) a worktree's agent session with the
 *  standard config assembled from the stores. The ONE place the `start_session`
 *  option bag is built — App's launch-resume, the Worktrees select, and the
 *  Settings-page open all route through here so they can't drift. Returns the
 *  start promise so callers flip status / handle errors at their call site. */
export function ensureSession(worktree: string): Promise<void> {
  return api.startSession(worktree, {
    resumeSessionId: get(sessionByWorktree)[worktree],
    permissionMode: get(permissionModeByWorktree)[worktree] ?? DEFAULT_PERMISSION_MODE,
    systemPromptAppend: get(systemPromptAppend),
    mcpServers: getMcpServers(),
    agents: getAgents(),
  });
}

/** Fire `request(worktree)` at most once per (worktree, key) pair within the
 *  lifetime of the caller-owned `seen` Set — the resilient "(re-)request when the
 *  list is still empty" pattern shared by the model / command / connector fetchers
 *  (the ready-time broadcast can race the listener). The Set is passed IN (one per
 *  component instance) on purpose: scoping it to the component means it resets when
 *  the component remounts or its session restarts, so a lost broadcast recovers on
 *  the next mount. A module-global Set would latch the request for the whole app
 *  lifetime and never re-fire. */
export function requestOnce(
  seen: Set<string>,
  worktree: string,
  key: string,
  request: (wt: string) => void,
) {
  const id = `${key} ${worktree}`;
  if (seen.has(id)) return;
  seen.add(id);
  request(worktree);
}

/** Build a compact recent-conversation string for a worktree to seed suggestion
 *  generation. Combines the persisted transcript with the un-flushed buffer so the
 *  just-ended turn is present, then defers to the pure `summarizeConversation`. */
export function recentConversation(worktree: string, maxMessages = 8, maxChars = 400): string {
  const all = (get(transcripts)[worktree] ?? []).concat(bufferedMessages(worktree));
  return summarizeConversation(all, maxMessages, maxChars);
}

// ---- Per-worktree pending permission (dormant under bypassPermissions) ----
const _pendingPerm = createWorktreeMap<PermissionReq | null>();
export const pendingPermission = _pendingPerm.store;
/** Set (or clear, with null) a worktree's pending permission request. */
export const setPendingPermission = _pendingPerm.set;

// ---- Per-worktree pending question (the agent's `ask_user`) ----
const _pendingQuestion = createWorktreeMap<QuestionReq | null>();
export const pendingQuestion = _pendingQuestion.store;
/** Set (or clear, with null) a worktree's pending `ask_user` question. */
export const setPendingQuestion = _pendingQuestion.set;

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
export const toolResultsById = derived(activeMessages, indexToolResults);

/** The newest `RENDER_WINDOW` messages of the selected transcript — what Chat
 *  actually mounts. Same object identities as `activeMessages` (a tail slice),
 *  so `__key` keying stays stable. */
export const renderedMessages = derived(activeMessages, ($m) => windowTail($m));

/** How many older messages sit above the render window (0 when nothing hidden). */
export const hiddenMessageCount = derived(activeMessages, ($m) => hiddenCount($m.length));

/** `renderedMessages` collapsed into render groups (see `groupMessages`). */
export const renderedGroups = derived(renderedMessages, groupMessages);

// ---- Derived "active" views (the SELECTED worktree's value, via the factory) ----
/** The selected worktree's pending permission request (null when none). */
export const activePending = _pendingPerm.active(null);
/** The selected worktree's pending question (null when none). */
export const activeQuestion = _pendingQuestion.active(null);
/** The current model of the selected worktree's chat (null until its session
 *  reports a `models` event). */
export const activeModel = _model.active(null);
/** The selected worktree's current agent activity (null when idle). */
export const activeActivity = _activity.active(null);
/** The selected worktree's last-completed-turn summary (null until a turn ends). */
export const activeSummary = _summary.active(null);
/** The selected worktree's change summary (null until fetched / when none). */
export const activeGitStat = _gitStat.active(null);
/** The selected worktree's suggested next replies (empty when none). */
export const activeSuggestions = _suggestions.active<string[]>([]);
/** The session default when a worktree has no explicit choice — preserves the
 *  historical silent-run behavior so enabling prompts is opt-in. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";
export { PERMISSION_MODES };
/** The selected worktree's permission mode (falls back to the default). */
export const activePermissionMode = _permMode.active(DEFAULT_PERMISSION_MODE);
