import { derived, get, type Readable, type Writable, writable } from "svelte/store";
import * as api from "./api";
import { createPersisted, createPersistedString, isPlainObject, parseJsonObject } from "./persist";
import { DEFAULT_PROVIDER_ID } from "./providers";
import type { ReviewComment } from "./review";
// Sibling store modules (threads.ts / session.ts) and stores.ts import each other
// — safe under ESM live bindings because every cross-module access happens at
// CALL time (see the CIRCULAR-IMPORT CONTRACT note in each sibling); these two
// mutators are used by selectWorktree / removeRepo below.
import { clearQueued } from "./session";
import { DEFAULT_THEME, THEMES as THEME_DEFS } from "./themes";
import { closeComment } from "./threads";
import {
  groupMessages,
  hiddenCount,
  indexToolResults,
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

// ---- Persistence primitive (the ONE template) ----
// Lives in `persist.ts` (the canonical home of createPersisted /
// createPersistedString / isPlainObject / parseJsonObject); imported above.

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
export interface WorktreeMap<T> {
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
/** Exported for the SIBLING STORE MODULES (threads.ts / session.ts) to build
 *  their per-worktree maps — never import it from a component. It must stay a
 *  hoisted `function` declaration (not a const): the siblings call it at their
 *  module eval, which under the circular import runs BEFORE this module's body. */
export function createWorktreeMap<T>(
  opts: { persistKey?: string; parse?: (raw: string) => Record<string, T> } = {},
): WorktreeMap<T> {
  const store = opts.persistKey
    ? createPersisted<Record<string, T>>(
        opts.persistKey,
        {},
        { parse: opts.parse ?? parseJsonObject },
      )
    : writable<Record<string, T>>({});
  function active<F>(fallback: F): Readable<T | F> {
    // Built lazily on FIRST SUBSCRIBE, not at the .active() call: the sibling
    // store modules call .active() at module eval, before this module's body has
    // initialized `selectedWorktree` — an eager derived() there would hit the
    // const's TDZ. Memoized so all subscribers still share ONE derived.
    let inner: Readable<T | F> | null = null;
    return {
      subscribe: (run, invalidate) =>
        (inner ??= derived([store, selectedWorktree], ([$m, $sel]) =>
          $sel ? ($m[$sel] ?? fallback) : fallback,
        )).subscribe(run, invalidate),
    };
  }
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
    active,
  };
}

// ---- UI state ----
/** Whether the left sidebar is visible. Toggled from the global header. */
export const sidebarOpen = writable<boolean>(true);
export function toggleSidebar() {
  sidebarOpen.update((v) => !v);
}

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
export type MainView = "chat" | "changes" | "run" | "term";
export const mainView = writable<MainView>("chat");
/** Set the main pane's view (the one mutator — see the store-mutator rule). */
export function setMainView(v: MainView) {
  mainView.set(v);
}
/** Toggle between a view and the chat (the header tabs' click behavior). */
export function toggleMainView(v: Exclude<MainView, "chat">) {
  mainView.update((cur) => (cur === v ? "chat" : v));
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
export function closeCommandPalette() {
  commandPaletteOpen.set(false);
}

/** Bumped to ask the sidebar to open its inline new-worktree field (⌘⇧N / the
 *  palette). Same nonce pattern as gitRefreshNonce; Worktrees watches it. */
export const newWorktreeRequest = writable<number>(0);
export function requestNewWorktree() {
  newWorktreeRequest.update((n) => n + 1);
}

/** Per-worktree change summary (changed-file count + diffstat). Populated by
 *  App.svelte from `worktree_status` on selection / gitRefreshNonce; drives the
 *  header's Changes tab — shown when there's anything to review: dirty files
 *  (with the +/- counts) OR commits over the default branch (`aheadOfDefault`),
 *  so a clean-but-unmerged branch keeps its PR/checks panel reachable. */
export interface GitStat {
  changed: number;
  insertions: number;
  deletions: number;
  aheadOfDefault: number;
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

/** Which action the git panel's split commit button performs by default. */
export type CommitMode = "commit" | "commit-push";
/** Persisted so the user's chosen commit action sticks across sessions. */
export const commitMode = createPersistedString("trickshot.commitMode", "commit-push", (raw) =>
  raw === "commit" || raw === "commit-push" ? raw : "commit-push",
);
/** Set the default commit action (validated by the store's parse). */
export function setCommitMode(mode: CommitMode) {
  commitMode.set(mode);
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
  closeComment();
}

// ---- Per-worktree session status ----
const _status = createWorktreeMap<SessionStatus>();
export const sessionStatus = _status.store;
export const setStatus = _status.set;
/** Drop a worktree's status entry entirely (e.g. on removal). */
export const clearStatus = _status.remove;
/** Whether the SELECTED worktree's session is alive (ready or busy) — the shared
 *  "can I talk to this session?" gate for the composer, model/permission
 *  selectors, and connector panel (previously copy-pasted in each). */
export const activeSessionAlive = derived(
  [sessionStatus, selectedWorktree],
  ([$st, $sel]) => !!$sel && ($st[$sel] === "ready" || $st[$sel] === "busy"),
);

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

// ---- Review queue (batched diff-line comments) ----
// Comments queued from the git panel's diff gutter, sent as ONE structured
// turn (`review.ts › formatReviewPrompt`). Persisted so an app restart doesn't
// eat a half-written review.
const _reviewQueue = createWorktreeMap<ReviewComment[]>({ persistKey: "trickshot.reviewQueue" });
export const reviewQueueByWorktree = _reviewQueue.store;
// Ids are identity keys and the queue persists — seed past the stored max so a
// restart can't mint colliding ids (remove-by-id would hit the wrong row).
let nextReviewId =
  1 +
  Object.values(get(reviewQueueByWorktree)).reduce(
    (max, list) => (list ?? []).reduce((m, c) => Math.max(m, c?.id ?? 0), max),
    0,
  );
/** The selected worktree's queued review comments (empty when none). */
export const activeReviewQueue = _reviewQueue.active<ReviewComment[]>([]);
/** Queue a review comment (no-op on blank text). Returns whether it queued. */
export function addReviewComment(worktree: string, c: Omit<ReviewComment, "id">): boolean {
  if (!c.text.trim()) return false;
  _reviewQueue.update(worktree, (cur) => [...(cur ?? []), { ...c, id: nextReviewId++ }]);
  return true;
}
/** Drop one queued comment by its stable id. */
export function removeReviewComment(worktree: string, id: number) {
  _reviewQueue.update(worktree, (cur) => (cur ?? []).filter((c) => c.id !== id));
}
/** Clear a worktree's whole review queue (same identity guard as clearQueued). */
export function clearReviewQueue(worktree: string) {
  _reviewQueue.store.update((m) => (m[worktree]?.length ? { ...m, [worktree]: [] } : m));
}

// ---- In-app notification history (the header bell) ----
// A session-only ring buffer of cross-worktree events (agent finished / needs
// attention), fed by the SAME call sites that raise OS notifications
// (agentEvents.ts turn_end, terminal.ts noteCliActivity). The bell lists them
// with click-to-jump; `notificationsSeenAt` drives the unseen count.
export interface AppNotification {
  id: number;
  worktree: string;
  title: string;
  body: string;
  at: number;
}
const NOTIFICATION_CAP = 50;
let nextNotificationId = 1;
export const appNotifications = writable<AppNotification[]>([]);
export const notificationsSeenAt = writable<number>(0);
/** Record an event in the bell's history (newest first, capped). */
export function pushAppNotification(worktree: string, title: string, body: string) {
  appNotifications.update((list) =>
    [{ id: nextNotificationId++, worktree, title, body, at: Date.now() }, ...list].slice(
      0,
      NOTIFICATION_CAP,
    ),
  );
}
/** Mark everything currently in the list as seen (the bell was opened). */
export function markNotificationsSeen() {
  notificationsSeenAt.set(Date.now());
}
export function clearAppNotifications() {
  appNotifications.set([]);
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
// Session catalogs are PER-WORKTREE: each session reports its own model list,
// slash commands, and MCP statuses (they differ by repo `.claude/commands` today
// and by provider tomorrow), so a global list would let concurrent sessions
// clobber each other — whichever emitted last would win for every chat. The
// `available*` exports are the selected worktree's view, so component reads
// keep their old shape.
const _availableModels = createWorktreeMap<ModelInfo[]>();
export const modelsByWorktree = _availableModels.store;
export function setAvailableModels(worktree: string, models: ModelInfo[]) {
  _availableModels.set(worktree, models);
}
/** The selected worktree's switchable-model catalog (empty until its session
 *  reports a `models` event). */
export const availableModels = _availableModels.active<ModelInfo[]>([]);

// Slash commands, per worktree (provider-supplied via the `commands` event);
// refreshed on session ready / get_commands.
const _availableCommands = createWorktreeMap<SlashCommandInfo[]>();
export const commandsByWorktree = _availableCommands.store;
export function setAvailableCommands(worktree: string, commands: SlashCommandInfo[]) {
  _availableCommands.set(worktree, commands);
}
/** The selected worktree's slash commands (empty until reported). */
export const availableCommands = _availableCommands.active<SlashCommandInfo[]>([]);

// ---- MCP integrations ----
// MCP server config is a JSON object (same shape as `.mcp.json`'s `mcpServers`),
// edited as raw JSON in Settings and applied at session start / live. Persisted.
export const mcpServersJson = createPersistedString("trickshot.mcpServersJson");
/** Parse the saved MCP JSON into a config object, or undefined if empty/invalid. */
export function getMcpServers(): Record<string, unknown> | undefined {
  return parseConfigBlob(get(mcpServersJson));
}
// MCP server statuses, per worktree (via each session's `mcp_status` event) —
// same per-session ownership as the model/command catalogs above.
const _mcpStatus = createWorktreeMap<McpStatusInfo[]>();
export const mcpStatusByWorktree = _mcpStatus.store;
export function setMcpStatus(worktree: string, servers: McpStatusInfo[]) {
  _mcpStatus.set(worktree, servers);
}
/** The selected worktree's MCP server statuses (empty until reported). */
export const mcpStatus = _mcpStatus.active<McpStatusInfo[]>([]);

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

// ---- Per-worktree provider (persisted) ----
// Which provider adapter a worktree's session runs (see `providers.ts` for the
// display registry and `sidecar/providers/` for the behavior). Applied at session
// start via the SESSION_CONFIG blob (`config.provider`, see ensureSession). There
// is no picker yet (Claude is the only adapter); the store exists so every
// provider-scoped consumer (auth/usage probes, error copy, resume/model
// invalidation) already reads through it instead of assuming Claude.
const _provider = createWorktreeMap<string>({ persistKey: "trickshot.providerByWorktree" });
export const providerByWorktree = _provider.store;
/** Switch a worktree's provider. A REAL change also drops the worktree's
 *  persisted model + session id — they're provider-specific (a Claude session id
 *  is meaningless to another adapter's resume, and its model ids aren't in the
 *  new catalog), so carrying them over would corrupt the next session start. */
export function setWorktreeProvider(worktree: string, id: string) {
  if ((get(providerByWorktree)[worktree] ?? DEFAULT_PROVIDER_ID) === id) return;
  _provider.set(worktree, id);
  _model.remove(worktree);
  forgetWorktreeSession(worktree);
  // A CLI chat mode is meaningless to a provider without one (see providers.ts
  // › cliChat) — same invalidation family as the model/session id above.
  _chatMode.remove(worktree);
}
/** The selected worktree's provider id (default provider when unset). */
export const activeProvider = _provider.active<string>(DEFAULT_PROVIDER_ID);

// ---- The chat surface (CLI-first deprecation switch) ----
// "cli": the REAL Claude Code TUI is the primary chat pane — selecting a
// worktree opens its claude PTY (no sidecar spawn; one session, one owner) and
// the GUI chat (Chat/Composer + suggestions/queue/threads/minimal) is
// deprecated-but-preserved, reachable only by flipping this back to "gui".
// ONE flag so the deprecation is greppable and reversible in one line; every
// fork it gates cites it. NOT a store — changing surfaces is a build decision,
// not runtime state.
export const CHAT_SURFACE: "cli" | "gui" = "cli";

// ---- Per-worktree chat mode (persisted): our GUI chat vs the real CLI ----
// DEPRECATED with CHAT_SURFACE === "cli" (the toggle UI is unwired); kept so
// the legacy GUI⇄CLI handoff (session.ts enterCliMode/exitCliMode) still works
// if the GUI surface returns.
// "cli" swaps the chat pane for a PTY running the provider's interactive CLI
// (Claude Code), resuming the same conversation — see session.ts ›
// enterCliMode/exitCliMode for the handoff choreography (the sidecar and the
// CLI must never hold the session concurrently). Gated per provider by
// providers.ts › cliChat; App.svelte falls back to "gui" when the provider has
// no CLI.
export type ChatMode = "gui" | "cli";
const CHAT_MODES: ChatMode[] = ["gui", "cli"];
const _chatMode = createWorktreeMap<ChatMode>({
  persistKey: "trickshot.chatModeByWorktree",
  // Drop any stored value outside the known set (shape guard for the template).
  parse: (raw) => {
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) return {};
    const out: Record<string, ChatMode> = {};
    for (const [k, mode] of Object.entries(v)) {
      if (CHAT_MODES.includes(mode as ChatMode)) out[k] = mode as ChatMode;
    }
    return out;
  },
});
export const chatModeByWorktree = _chatMode.store;
export const setChatMode = _chatMode.set;
/** The selected worktree's chat mode (GUI when unset). */
export const activeChatMode = _chatMode.active<ChatMode>("gui");

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
    // Shape guard for the CURRENT windows-list shape; the old five_hour/seven_day
    // object (pre-neutralization) fails it and falls back to null (re-fetched).
    return isPlainObject(v) && Array.isArray(v.windows) ? (v as unknown as UsageInfo) : null;
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
    // Probe the ACTIVE chat's provider account (the chip describes the session
    // the user is looking at); no selection falls back to the default provider.
    usageLimits.set(await api.getUsage(get(activeProvider)));
    usageError.set(null);
    usageLastFetch = Date.now();
  } catch (e) {
    usageError.set(e instanceof Error ? e.message : String(e));
  } finally {
    usageInFlight = false;
  }
}

// ---- Provider login presence (ambient app state, not persisted) ----
// Drives the first-run "sign in" notice (Welcome + the composer banner, see
// AuthNotice). Only a DEFINITIVE "no credentials anywhere" flips to `missing`;
// ambiguous check failures (keychain/HOME errors) leave the state alone so we
// never false-alarm.
export const authState = writable<"unknown" | "ok" | "missing">("unknown");
/** Set the ambient auth state (the one mutator — agentEvents flips it to
 *  `missing` on a recognized auth failure; refreshAuth settles it). */
export function setAuthState(v: "unknown" | "ok" | "missing") {
  authState.set(v);
}

/** Re-probe the active provider's login (local credential read, no network).
 *  Called on launch, on window focus while `missing` (the sign-in-in-a-terminal
 *  round trip), and by the notice's retry button. */
export async function refreshAuth() {
  try {
    authState.set((await api.checkAuth(get(activeProvider))) ? "ok" : "missing");
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
export function setMinimalMode(on: boolean) {
  minimalMode.set(on);
}

// ---- Chat skin (global, persisted) ----
// Visual style of the GUI chat: the default bubble look, or a terminal-like
// skin (mono prompt-line turns, flattened bubbles — see app.css
// `[data-chat-skin="terminal"]`). A string (not a boolean) so a future third
// skin is an entry, not a migration. Global on purpose — aesthetic preferences
// (theme/font/minimal) are app-wide, never per-worktree.
export type ChatSkin = "default" | "terminal";
export const chatSkin = createPersisted<ChatSkin>("trickshot.chatSkin", "default", {
  parse: (raw) => {
    const v = JSON.parse(raw);
    return v === "terminal" ? "terminal" : "default";
  },
});
export function setChatSkin(skin: ChatSkin) {
  chatSkin.set(skin);
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
  // Skip the write when the id is unchanged — same map identity skips the allocation + primitive-derived re-renders (see stores.test.ts).
  _session.store.update((m) => (m[worktree] === id ? m : { ...m, [worktree]: id }));
}
/** Forget a worktree's persisted session + transcript (e.g. on worktree removal,
 *  so a recreated worktree at the same path starts clean). */
export const forgetWorktreeSession = _session.remove;

export type { QueuedMessage } from "./session";

// ---- Session/turn orchestration + queued follow-ups ----
// Submitting a user turn, the queued-message drain, ensureSession's config bag,
// and the repo/worktree activation paths live in `session.ts` (the transcript.ts
// precedent); re-export so `import { submitUserTurn } from "./stores"` keeps working.
export {
  activateWorktree,
  activeQueued,
  clearQueued,
  consumeSuppressDrain,
  enqueueMessage,
  ensureClaudeOpen,
  ensureSession,
  enterCliMode,
  exitCliMode,
  handleCliExit,
  maybeDrainQueued,
  openRepository,
  queuedByWorktree,
  recentConversation,
  removeQueued,
  requestOnce,
  restoreWorkspace,
  sendQueuedNow,
  sendToCli,
  submitTurnToChat,
  submitUserTurn,
  suppressNextDrain,
} from "./session";
// ---- Per-worktree transcripts ----
// The batching / persistence / windowing / grouping engine lives in
// `transcript.ts` (a self-contained subsystem with its own invariants); re-export
// the mutators so `import { appendMessage } from "./stores"` keeps working and
// transcript writes still have ONE home (see CLAUDE.md).
export { appendMessage, resetTranscript, transcripts } from "./transcript";

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
// The thread subsystem — state, mutators, and the one submit path — lives in
// `threads.ts` (the transcript.ts precedent; the pure data model stays in
// comments.ts); re-export so `import { openThreadFor } from "./stores"` keeps working.
export {
  activeCommentId,
  activeComments,
  addComment,
  appendCommentDelta,
  appendCommentMessage,
  closeComment,
  commentsByWorktree,
  openComment,
  openThreadFor,
  removeComment,
  removeComments,
  setCommentError,
  setCommentPending,
  submitCommentTurn,
} from "./threads";

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
