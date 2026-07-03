import { derived, get, type Readable, type Writable, writable } from "svelte/store";
import * as api from "./api";
import { buildCommentPrompt, type CommentMessage, type CommentThread } from "./comments";
import { MINIMAL_DIRECTIVE } from "./minimal";
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
  ScriptsConfig,
  SlashCommandInfo,
  UsageInfo,
  Worktree,
} from "./types";
import { basename } from "./utils";

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
 *  - `starting` — sidecar spawned, awaiting its `ready` event (the boot gap)
 *  - `ready`   — sidecar is alive and idle, awaiting input
 *  - `busy`    — a turn is in flight (set on send, cleared on the `result` message)
 *  - `stopped` — no live sidecar (never started, terminated, or errored) */
export type SessionStatus = "starting" | "ready" | "busy" | "stopped";

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

/** Which view the main pane shows for the selected worktree: the chat transcript,
 *  the git "changes" (diff) panel, the script "run" output, or the integrated
 *  terminal. Ephemeral UI state. */
export const mainView = writable<"chat" | "changes" | "run" | "term">("chat");

/** Which inline-comment thread popup is open (its id), or null. Ephemeral, global
 *  (the selection is always within the on-screen chat); cleared on worktree switch. */
export const activeCommentId = writable<string | null>(null);
/** Open a comment thread's popup. */
export function openComment(id: string) {
  activeCommentId.set(id);
}
/** Close the open comment popup (no cancel — the caller aborts any in-flight turn). */
export function closeComment() {
  activeCommentId.set(null);
}

/** Bumped to ask an open GitPanel to re-fetch status/diff (e.g. after a turn that
 *  likely touched files). A monotonic counter the panel watches. */
export const gitRefreshNonce = writable<number>(0);
export function bumpGitRefresh() {
  gitRefreshNonce.update((n) => n + 1);
}

/** Whether the ⌘K command palette is open. Ephemeral, global (App owns the
 *  shortcut, CommandPalette renders). */
export const commandPaletteOpen = writable<boolean>(false);
export function toggleCommandPalette() {
  commandPaletteOpen.update((v) => !v);
}

/** Bumped to ask the sidebar to open its inline new-worktree field (⌘⇧N / the
 *  palette). Same nonce pattern as gitRefreshNonce; Worktrees watches it. */
export const newWorktreeRequest = writable<number>(0);
export function requestNewWorktree() {
  newWorktreeRequest.update((n) => n + 1);
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
/** Select a worktree (or clear with `null`). The one mutator for the persisted
 *  selection — components call this, not `selectedWorktree.set()` inline. */
export function selectWorktree(path: string | null) {
  selectedWorktree.set(path);
  // Close any open comment popup — it belongs to the chat we're leaving.
  activeCommentId.set(null);
}

// ---- Per-worktree session status ----
const _status = createWorktreeMap<SessionStatus>();
export const sessionStatus = _status.store;
export const setStatus = _status.set;
/** Drop a worktree's status entry entirely (e.g. on removal). */
export const clearStatus = _status.remove;

/** Remove a repo from trickshot's sidebar. Does NOT delete the git repo on disk —
 *  it just drops it from the app: stops any running sessions for its worktrees,
 *  removes its worktree list, and clears the selection if it pointed into the repo. */
export function removeRepo(repoPath: string) {
  const wts = get(worktreesByRepo)[repoPath] ?? [];
  const sel = get(selectedWorktree);
  for (const wt of wts) {
    api.stopSession(wt.path);
    api.stopScript(wt.path);
    clearStatus(wt.path);
    clearQueued(wt.path);
    removeScriptRun(wt.path);
  }
  if (sel && wts.some((w) => w.path === sel)) selectWorktree(null);
  worktreesByRepo.update((m) => {
    const next = { ...m };
    delete next[repoPath];
    return next;
  });
  repos.update((rs) => rs.filter((r) => r.path !== repoPath));
}

/** The repo that owns the selected worktree — its path IS the main worktree
 *  (repos are added by picking the main checkout). The shared derivation for
 *  every "act on the selected worktree's repo" consumer (merge, scripts, PRs). */
export const activeRepo = derived(
  [repos, worktreesByRepo, selectedWorktree],
  ([$repos, $wts, $sel]) =>
    $sel ? ($repos.find((r) => ($wts[r.path] ?? []).some((w) => w.path === $sel)) ?? null) : null,
);

// ---- Project scripts (.trickshot/settings.json, per repo) ----
// The parsed scripts config per repo path (setup / named run scripts / archive).
// Git-adjacent disk state like worktree lists: refreshed from the file on demand,
// never persisted here.
export const scriptsByRepo = writable<Record<string, ScriptsConfig>>({});
/** Re-read a repo's scripts config from disk (missing file → empty config). */
export async function refreshScripts(repoPath: string) {
  try {
    const cfg = await api.getScripts(repoPath);
    scriptsByRepo.update((m) => ({ ...m, [repoPath]: cfg }));
  } catch {
    // unreadable/invalid settings file — keep the last good value
  }
}

// ---- Per-worktree script run (the Run button's live process) ----
// One script per worktree (Rust enforces it); this mirrors its lifecycle for the
// Run tab: name, running/exited, exit code, and a BOUNDED output tail. Appends
// arrive pre-batched from scriptEvents.ts (16ms coalescing, mirroring the
// transcript engine) so a chatty build log is one store write per flush, not per line.
export interface ScriptRun {
  name: string;
  status: "running" | "exited";
  code: number | null;
  output: string[];
}
const SCRIPT_OUTPUT_MAX = 2000;
const _scriptRun = createWorktreeMap<ScriptRun>();
export const scriptRunByWorktree = _scriptRun.store;
/** Begin a fresh run (clears the previous run's output). */
export function startScriptRun(worktree: string, name: string) {
  _scriptRun.set(worktree, { name, status: "running", code: null, output: [] });
}
/** Append a flushed batch of output lines, trimming to the bounded tail. */
export function appendScriptLines(worktree: string, lines: string[]) {
  if (!lines.length) return;
  _scriptRun.update(worktree, (cur) => {
    const run = cur ?? { name: "", status: "running" as const, code: null, output: [] };
    const output = run.output.concat(lines);
    if (output.length > SCRIPT_OUTPUT_MAX) output.splice(0, output.length - SCRIPT_OUTPUT_MAX);
    return { ...run, output };
  });
}
/** Mark the run exited with its status code (null = killed / unknown). */
export function endScriptRun(worktree: string, code: number | null) {
  _scriptRun.update(worktree, (cur) => ({
    ...(cur ?? { name: "", output: [] }),
    status: "exited" as const,
    code,
  }));
}
/** Drop a worktree's run state entirely (worktree removal). */
export const removeScriptRun = _scriptRun.remove;

// ---- Archived workspaces (persisted) ----
// Conductor-style archive: the worktree DIR is removed (branch kept) but its
// persisted transcript / session id / comments are deliberately LEFT in place,
// keyed by the worktree path. Because the path scheme is deterministic
// (`../.<repo>-worktrees/<branch>`), restoring the branch recreates the same
// key and the chat + agent context come back through the existing persistence
// mechanisms. This list is just the sidebar's "History" index of those parked
// workspaces. Permanent delete is the point where the orphaned state is purged.
export interface ArchivedWorkspace {
  repoPath: string;
  repoName: string;
  branch: string;
  /** The worktree path at archive time (the transcript/session/comments key). */
  path: string;
  archivedAt: number;
}
export const archivedWorkspaces = createPersisted<ArchivedWorkspace[]>("trickshot.archived", [], {
  parse: (raw) => {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter(
          (a) =>
            isPlainObject(a) &&
            typeof a.repoPath === "string" &&
            typeof a.branch === "string" &&
            typeof a.path === "string",
        )
      : [];
  },
});
/** Park a workspace in the archive (replaces an older entry for the same
 *  repo+branch — re-archiving must not duplicate). */
export function addArchived(entry: ArchivedWorkspace) {
  archivedWorkspaces.update((list) => [
    ...list.filter((a) => !(a.repoPath === entry.repoPath && a.branch === entry.branch)),
    entry,
  ]);
}
/** Drop an archive entry (after a restore, or a permanent delete). */
export function removeArchived(repoPath: string, branch: string) {
  archivedWorkspaces.update((list) =>
    list.filter((a) => !(a.repoPath === repoPath && a.branch === branch)),
  );
}

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
  // same map identity skips the allocation + primitive-derived re-renders (see stores.test.ts).
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

// ---- Claude Code login presence (ambient app state, not persisted) ----
// Drives the first-run "sign in" notice (Welcome + the composer banner). Only a
// DEFINITIVE "no credentials anywhere" flips to `missing`; ambiguous check
// failures (keychain/HOME errors) leave the state alone so we never false-alarm.
export const authState = writable<"unknown" | "ok" | "missing">("unknown");

/** Re-probe the Claude Code login (local credential read, no network). Called on
 *  launch, on window focus while `missing` (the sign-in-in-a-terminal round trip),
 *  and by the notice's retry button. */
export async function refreshAuth() {
  try {
    authState.set((await api.checkAuth()) ? "ok" : "missing");
  } catch {
    // ambiguous (keychain spawn failure, HOME unset) — stay silent
  }
}

// ---- Per-worktree permission mode (persisted) ----
// Controls how the agent's tool use is gated. `bypassPermissions` (the historical
// default) runs every tool silently; the others route tool use through the
// Allow/Deny modal. Applied at session start (via the SESSION_CONFIG blob's
// `permissionMode`, see ensureSession) and switched live via the
// `set_permission_mode` command.
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
  // Skip the write when already empty — same map identity skips the allocation + primitive-derived re-renders (see stores.test.ts).
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

// ---- Minimal mode (global, persisted) ----
// A reversible VIEW FILTER: while on, every user turn is sent with an appended
// directive (see minimal.ts) asking the agent to end its reply with a one-sentence
// summary, and Chat renders ONLY those summaries + the user's messages. The full
// response stays in the transcript — toggling off reveals everything again.
export const minimalMode = createPersisted<boolean>("trickshot.minimalMode", false);

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
  // Skip the write when the id is unchanged — same map identity skips the allocation + primitive-derived re-renders (see stores.test.ts).
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
    // The transcript echo (above) stays clean; only the wire copy carries the
    // minimal-mode directive so the agent appends its one-sentence summary.
    await api.sendUserTurn(worktree, get(minimalMode) ? t + MINIMAL_DIRECTIVE : t);
  } catch (e) {
    appendMessage(worktree, { type: "error", error: `failed to send: ${e}` });
    setStatus(worktree, "ready");
    clearActivity(worktree);
  }
}

// ---- Per-worktree queued follow-up messages (ephemeral; NOT persisted) ----
// Messages typed while the agent is busy. They drain ONE per turn: each natural
// `turn_end` (see agentEvents.ts) pops the front and submits it as the next turn.
// `sendQueuedNow` interrupts the in-flight turn and sends the front immediately.
// Built purely on `submitUserTurn` + `interrupt` — no new wire protocol.
const _queued = createWorktreeMap<string[]>();
export const queuedByWorktree = _queued.store;
/** The selected worktree's queued follow-ups (empty when none). */
export const activeQueued = _queued.active<string[]>([]);
/** Append a follow-up to a worktree's queue (no-op on blank text). */
export function enqueueMessage(worktree: string, text: string) {
  const t = text.trim();
  if (!t) return;
  _queued.update(worktree, (cur) => [...(cur ?? []), t]);
}
/** Drop one queued message by index (the per-item remove). */
export function removeQueuedAt(worktree: string, index: number) {
  _queued.update(worktree, (cur) => (cur ?? []).filter((_, i) => i !== index));
}
/** Clear a worktree's whole queue. Same no-op identity guard as clearSuggestions. */
export function clearQueued(worktree: string) {
  _queued.store.update((m) => (m[worktree]?.length ? { ...m, [worktree]: [] } : m));
}
/** Pop the FRONT queued message and submit it as a normal turn. Returns whether one
 *  was sent — the `turn_end` drain uses this to skip the "finished" side-effects when
 *  a follow-up is starting. */
export function maybeDrainQueued(worktree: string): boolean {
  const [next, ...rest] = get(queuedByWorktree)[worktree] ?? [];
  if (next === undefined) return false;
  _queued.set(worktree, rest);
  void submitUserTurn(worktree, next); // sets busy + optimistic bubble + IPC
  return true;
}
/** Interrupt the in-flight turn and send the next queued message now. An interrupt
 *  itself emits a `result` → `turn_end` (the SDK aborts the turn, see claudeMapping),
 *  and the `turn_end` drain then sends the front — so while busy we ONLY interrupt and
 *  let that path run (no double-send, no mid-turn status flip). When already idle there
 *  is no turn to interrupt (and thus no `turn_end`), so send directly. */
export function sendQueuedNow(worktree: string) {
  if (!(get(queuedByWorktree)[worktree] ?? []).length) return;
  if (get(sessionStatus)[worktree] === "busy") api.interruptAgent(worktree);
  else maybeDrainQueued(worktree);
}

// One-shot, per-worktree "the next turn_end is from a Stop — don't drain" flag.
// An interrupt emits a `turn_end`; the queue drain runs on `turn_end`, so Stop would
// otherwise fire a queued follow-up. The Stop path sets this; the resulting `turn_end`
// consumes it and skips the drain (leaving the queue intact). `sendQueuedNow`
// deliberately does NOT set it — its interrupt's `turn_end` SHOULD drain.
const _suppressDrain = new Set<string>();
export function suppressNextDrain(worktree: string) {
  _suppressDrain.add(worktree);
}
/** Returns whether a Stop-suppression was pending (and clears it). */
export function consumeSuppressDrain(worktree: string): boolean {
  return _suppressDrain.delete(worktree);
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

/** Activate a worktree: select it, return the center pane to the chat, clear
 *  its unread badge, and (re)start its session. The ONE activation path — the
 *  sidebar row and the command palette both route through here. Throws on a
 *  session-start failure so callers surface it in their local error state. */
/** Pick a folder and open it as a repo: validate it's a git repo FIRST (so a
 *  bad pick never persists a junk entry), then add it, cache its worktrees, and
 *  activate the main worktree so the user lands in a live chat. The ONE add-repo
 *  path — the Welcome CTA and the sidebar's FolderPlus both route through here.
 *  Returns false when the picker is cancelled; throws on failure so callers
 *  surface it in their local error state. */
export async function openRepository(): Promise<boolean> {
  const p = await api.pickDirectory();
  if (!p) return false;
  const wts = await api.listWorktrees(p); // validate before persisting
  // A bare entry has no working files, so it can't host an agent session. Land
  // on the first non-bare worktree; a repo with ONLY bare entries is rejected
  // before anything persists.
  const usable = wts.filter((w) => !w.is_bare);
  if (usable.length === 0) {
    throw new Error("that's a bare repository — pick a working checkout");
  }
  addRepo({ path: p, name: basename(p) });
  setWorktrees(p, wts);
  const main = usable.find((w) => w.is_main) ?? usable[0];
  if (main) await activateWorktree(main.path);
  return true;
}

export async function activateWorktree(path: string) {
  selectWorktree(path);
  setCenterView("chat");
  clearUnread(path);
  // Show the boot gap ONLY when a sidecar will actually spawn: an already-live
  // session (ready/busy) re-emits no `ready` event, so blindly setting
  // `starting` on a plain worktree switch would stick forever. The sidecar's
  // `ready` event — not spawn success — is what flips the status to ready.
  const st = get(sessionStatus)[path];
  if (!st || st === "stopped") setStatus(path, "starting");
  try {
    await ensureSession(path);
  } catch (e) {
    setStatus(path, "stopped");
    throw e;
  }
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
export function recentConversation(
  worktree: string,
  maxMessages?: number,
  maxChars?: number,
): string {
  const all = (get(transcripts)[worktree] ?? []).concat(bufferedMessages(worktree));
  // Pass through (undefined falls back to summarizeConversation's own defaults) so
  // the message/char caps live in ONE place, not duplicated here.
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

// ---- Per-worktree threads (Slack-style, one per agent message; persisted) ----
// A thread is an OUT-OF-BAND side-conversation (see comments.ts) anchored to one
// agent message's `__key`: turns are answered by an isolated sidecar query seeded
// with the full conversation up to that message, and NEVER enter the main
// session/transcript. Persisted so threads survive a restart. `pending`/`error`
// are runtime-only — the load guard resets them so a mid-stream crash can't leave
// a thread stuck pending. (`.v2`: the row shape changed from the old highlight-
// anchored model, so old threads are dropped on load.)
const _comments = createWorktreeMap<CommentThread[]>({
  persistKey: "trickshot.commentsByWorktree.v2",
  parse: (raw) => {
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) return {};
    const out: Record<string, CommentThread[]> = {};
    for (const [wt, list] of Object.entries(v)) {
      if (!Array.isArray(list)) continue;
      out[wt] = list
        .filter(
          (t): t is CommentThread =>
            isPlainObject(t) && typeof t.id === "string" && typeof t.messageKey === "number",
        )
        // Drop transient state: an answer can't still be streaming across a reload.
        .map((t) => ({ ...t, pending: false, error: undefined }));
    }
    return out;
  },
});
export const commentsByWorktree = _comments.store;
/** The selected worktree's comment threads (empty when none). */
export const activeComments = _comments.active<CommentThread[]>([]);

/** Update one thread in a worktree's list (no-op if absent). */
function updateThread(worktree: string, id: string, fn: (t: CommentThread) => CommentThread) {
  _comments.update(worktree, (cur) => (cur ?? []).map((t) => (t.id === id ? fn(t) : t)));
}
/** Add a new comment thread to a worktree. */
export function addComment(worktree: string, thread: CommentThread) {
  _comments.update(worktree, (cur) => [...(cur ?? []), thread]);
}
/** Remove a comment thread (e.g. an empty draft closed without sending). */
export function removeComment(worktree: string, id: string) {
  _comments.update(worktree, (cur) => (cur ?? []).filter((t) => t.id !== id));
}
/** Append a finished message (user question / agent answer) to a thread. */
export function appendCommentMessage(worktree: string, id: string, msg: CommentMessage) {
  updateThread(worktree, id, (t) => ({ ...t, messages: [...t.messages, msg] }));
}
/** Append a streamed answer delta: extend the current turn's assistant message, or
 *  start one if the last message is the user's question (no answer yet this turn). */
export function appendCommentDelta(worktree: string, id: string, text: string) {
  updateThread(worktree, id, (t) => {
    const last = t.messages[t.messages.length - 1];
    if (last && last.role === "assistant") {
      const messages = t.messages.slice(0, -1).concat({ ...last, text: last.text + text });
      return { ...t, messages };
    }
    return { ...t, messages: [...t.messages, { role: "assistant", text }] };
  });
}
/** Mark a thread's answer as streaming / settled. Stamps `pendingSince` when the
 *  turn starts so the thinking indicator's elapsed timer counts from the right t0. */
export function setCommentPending(worktree: string, id: string, pending: boolean) {
  updateThread(worktree, id, (t) => ({
    ...t,
    pending,
    pendingSince: pending ? Date.now() : t.pendingSince,
  }));
}
/** Record a failed comment turn (also clears pending). */
export function setCommentError(worktree: string, id: string, error: string) {
  updateThread(worktree, id, (t) => ({ ...t, pending: false, error }));
}
/** Drop ALL comments for a worktree (on transcript reset / worktree removal so
 *  orphaned anchors don't linger). Same no-op identity guard as the map factory. */
export const removeComments = _comments.remove;

/** Open the thread for an agent message (by its transcript `__key`), creating an
 *  empty one if none exists yet. The single entry point the chat uses, so Message
 *  stays a store-free primitive (it just calls a handler). */
export function openThreadFor(worktree: string, messageKey: number) {
  const existing = (get(commentsByWorktree)[worktree] ?? []).find(
    (t) => t.messageKey === messageKey,
  );
  if (existing) {
    openComment(existing.id);
    return;
  }
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `t-${messageKey}`;
  addComment(worktree, { id, messageKey, messages: [], pending: false, createdAt: Date.now() });
  openComment(id);
}

/** The full text of an anchored transcript message (for prompt context), or "". */
function anchoredMessageText(worktree: string, messageKey: number): string {
  for (const m of get(transcripts)[worktree] ?? []) {
    if (m.__key !== messageKey) continue;
    if (m.type === "assistant" || m.type === "user_local") return m.text ?? "";
    return "";
  }
  return "";
}

/** The main-chat conversation UP TO AND INCLUDING the anchored message, as prompt
 *  context for a thread (so the agent has the full thread of the discussion, not a
 *  blank slate). High caps honor "full context" while bounding pathological chats;
 *  `buildCommentPrompt` clamps the total again. Reuses `summarizeConversation`. */
function conversationUpTo(worktree: string, messageKey: number): string {
  const all = (get(transcripts)[worktree] ?? []).concat(bufferedMessages(worktree));
  const idx = all.findIndex((m) => m.__key === messageKey);
  const slice = idx >= 0 ? all.slice(0, idx + 1) : all;
  return summarizeConversation(slice, 1000, 4000);
}

/** Submit one turn of a thread (the ONE submit path). Appends the user's question,
 *  marks the thread pending, assembles the out-of-band prompt (full conversation up
 *  to the anchored message + the anchored message itself + prior thread Q&A + the
 *  new question) and fires the isolated IPC. NEVER touches the main transcript or
 *  session status — threads are out-of-band. The streamed answer arrives via
 *  `comment_reply` (see agentEvents.ts). */
export async function submitCommentTurn(worktree: string, id: string, question: string) {
  const q = question.trim();
  if (!q) return;
  const thread = (get(commentsByWorktree)[worktree] ?? []).find((t) => t.id === id);
  if (!thread) return;
  // Prior turns BEFORE we append the new question (the thread's memory).
  const priorMessages = thread.messages.slice();
  appendCommentMessage(worktree, id, { role: "user", text: q });
  setCommentPending(worktree, id, true);
  try {
    // Full context: the conversation up to the anchored message + that message in
    // full. Inside the try so any assembly failure surfaces as a thread error
    // (clears pending) instead of an unhandled rejection that hangs on "Thinking…".
    const prompt = buildCommentPrompt({
      conversation: conversationUpTo(worktree, thread.messageKey),
      anchoredMessage: anchoredMessageText(worktree, thread.messageKey),
      priorMessages,
      newQuestion: q,
    });
    await api.sendCommentTurn(worktree, id, prompt);
  } catch (e) {
    setCommentError(worktree, id, `failed to send: ${e}`);
  }
}

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
/** The selected worktree's script run (null until one is launched). */
export const activeScriptRun = _scriptRun.active(null);
/** The owning repo's scripts config (null until fetched / no repo). */
export const activeScripts = derived([scriptsByRepo, activeRepo], ([$cfg, $repo]) =>
  $repo ? ($cfg[$repo.path] ?? null) : null,
);
/** The selected worktree's suggested next replies (empty when none). */
export const activeSuggestions = _suggestions.active<string[]>([]);
/** The session default when a worktree has no explicit choice — preserves the
 *  historical silent-run behavior so enabling prompts is opt-in. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";
export { PERMISSION_MODES };
/** The selected worktree's permission mode (falls back to the default). */
export const activePermissionMode = _permMode.active(DEFAULT_PERMISSION_MODE);
