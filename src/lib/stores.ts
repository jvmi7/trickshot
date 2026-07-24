import { derived, get, type Readable, type Writable, writable } from "svelte/store";
import * as api from "./api";
import {
  createPersisted,
  createPersistedString,
  isPlainObject,
  parseJsonObject,
  purgeRetiredKeys,
} from "./persist";
import { DEFAULT_PROVIDER_ID } from "./providers";
import type { ReviewComment } from "./review";
import {
  heal,
  isSplitNode,
  moveLeaf,
  type SplitNode,
  type SplitWhere,
  splitLeaf,
} from "./splitTree";
import { profileAccent } from "./termProfiles";
import { DEFAULT_THEME, THEMES as THEME_DEFS } from "./themes";
import type { Repo, ScriptsConfig, UsageInfo, Worktree } from "./types";

/** A worktree's CLI session lifecycle:
 *  - `ready`   — the claude PTY is alive and idle, awaiting input
 *  - `busy`    — a turn is in flight (derived from the PTY's output flow —
 *    see cliActivity.ts / terminal.ts › noteCliActivity)
 *  - `stopped` — no live CLI (never opened, exited, or crashed) */
export type SessionStatus = "ready" | "busy" | "stopped";

// ---- Persistence primitive (the ONE template) ----
// Lives in `persist.ts` (the canonical home of createPersisted /
// createPersistedString / isPlainObject / parseJsonObject); imported above.

// Drop localStorage keys retired with the GUI chat surface (transcripts,
// threads, sidecar-session prefs) — see persist.ts › purgeRetiredKeys.
purgeRetiredKeys();

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
/** Exported for SIBLING STORE MODULES (the session.ts pattern) to build
 *  per-worktree maps — never import it from a component. It must stay a
 *  hoisted `function` declaration (not a const): a sibling calls it at its
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

/** Which view the main pane shows for the selected worktree: the chat
 *  terminal or the script "run" output. (Git changes AND the shell terminal
 *  are header POPOVERS — `changesOpen`/`shellOpen` below — not pages.)
 *  Ephemeral UI state. */
export type MainView = "chat" | "run";
export const mainView = writable<MainView>("chat");
/** Set the main pane's view (the one mutator — see the store-mutator rule). */
export function setMainView(v: MainView) {
  mainView.set(v);
}
/** Toggle between a view and the chat (the header tabs' click behavior). */
export function toggleMainView(v: Exclude<MainView, "chat">) {
  mainView.update((cur) => (cur === v ? "chat" : v));
}

/** Whether the git Changes POPOVER (header ± trigger) is open — a dropdown
 *  panel over the terminal, not a page swap. Ephemeral. */
export const changesOpen = writable<boolean>(false);
export function setChangesOpen(v: boolean) {
  changesOpen.set(v);
}
export function toggleChanges() {
  changesOpen.update((v) => !v);
}

/** Whether the SHELL terminal popover is open. The PTY + xterm scrollback
 *  persist across open/close (lib/terminal.ts instance cache) — the popover
 *  only re-parents the same terminal. Ephemeral. */
export const shellOpen = writable<boolean>(false);
export function setShellOpen(v: boolean) {
  shellOpen.set(v);
}
export function toggleShell() {
  shellOpen.update((v) => !v);
}

/** Whether the ⌘E compose popup is open (a full editor for long prompts,
 *  injected into the CLI chat via bracketed paste). Ephemeral; the draft
 *  survives close-without-send within the session. */
export const composeOpen = writable<boolean>(false);
export const composeDraft = writable<string>("");
export function setComposeOpen(v: boolean) {
  composeOpen.set(v);
}
export function toggleCompose() {
  composeOpen.update((v) => !v);
}

/** Whether the ⌘/ keyboard-shortcuts overlay is open. Ephemeral, global. */
export const shortcutsHelpOpen = writable<boolean>(false);
export function toggleShortcutsHelp() {
  shortcutsHelpOpen.update((v) => !v);
}
export function setShortcutsHelpOpen(v: boolean) {
  shortcutsHelpOpen.set(v);
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

// ---- Repo icons (sidebar favicons) ----
/** `data:` URI per repo path; null = probed, none found (the sidebar renders
 *  its placeholder icon). Keyed by REPO path (not worktree), so a plain map —
 *  and NOT persisted: icons change on disk, and a base64 blob per repo would
 *  bloat localStorage for a purely cosmetic cache. */
export const repoIconByRepo = writable<Record<string, string | null>>({});
const iconRequested = new Set<string>();
/** Fetch a repo's favicon once per app run (idempotent; failure = null). */
export function loadRepoIcon(repoPath: string) {
  if (iconRequested.has(repoPath)) return;
  iconRequested.add(repoPath);
  api
    .repoIcon(repoPath)
    .then((uri) => repoIconByRepo.update((m) => ({ ...m, [repoPath]: uri })))
    .catch(() => repoIconByRepo.update((m) => ({ ...m, [repoPath]: null })));
}

// ---- Home workspace (~) ----
/** The Home workspace root — the user's home directory, a workspace OUTSIDE
 *  any repo/worktree. Resolved once at launch (App.svelte's rehydrate flow);
 *  the sidebar's Home row renders only once this is known. Not persisted —
 *  it's an OS fact, refetched each run. */
export const homePath = writable<string | null>(null);

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
// Per-workspace identity var: every workspace has a stable TERMINAL PROFILE
// (termProfiles.ts — ANSI palette + accent, path-hash assigned). The SELECTED
// workspace's accent reflects onto <html> for the header ❯. (Backgrounds are
// deliberately UNIFORM — the app theme's — so only the accent differentiates.)
selectedWorktree.subscribe((sel) => {
  if (typeof document === "undefined") return;
  const st = document.documentElement.style;
  if (sel) st.setProperty("--ws-accent", profileAccent(sel));
  else st.removeProperty("--ws-accent");
});

export function selectWorktree(path: string | null) {
  selectedWorktree.set(path);
}

// ---- Per-worktree session status ----
const _status = createWorktreeMap<SessionStatus>();
export const sessionStatus = _status.store;
export const setStatus = _status.set;
/** Drop a worktree's status entry entirely (e.g. on removal). */
export const clearStatus = _status.remove;

// ---- Multi-chat sessions (several concurrent CLI chats per worktree) ----
// The MODEL is "chat sessions"; tabs and the n-up grid are two RENDERINGS of
// the same store (ClaudeTerminalPane). Each chat owns a claude-slot PTY (key =
// terminal.ts › claudeTermKey(worktree, chat.id)) and a Claude Code session id
// — deterministic from birth (`--session-id`) or adopted on first resume; the
// modern CLI's `--resume` KEEPS the id (`--fork-session` is opt-in), so a
// stored id stays the live thread across restarts.

/** The default chat's id — its PTY key stays the BARE claude slot so
 *  pre-multi-chat sessions keep working. Hand-mirrored by `DEFAULT_CHAT`
 *  in src-tauri/src/terminal.rs. */
export const DEFAULT_CHAT_ID = "main";

export interface ChatSession {
  id: string;
  /** The Claude Code session id (transcript identity). Set at first open. */
  sessionId?: string;
  createdAt: number;
}

/** Chats per worktree (persisted — the tab set survives restarts; each chat's
 *  conversation lives in Claude Code's own session store via its sessionId). */
const _chats = createWorktreeMap<ChatSession[]>({
  persistKey: "trickshot.chats",
  parse: (raw) => {
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) return {};
    const out: Record<string, ChatSession[]> = {};
    for (const [wt, list] of Object.entries(v)) {
      if (Array.isArray(list) && list.every((c) => isPlainObject(c) && typeof c.id === "string")) {
        out[wt] = list as ChatSession[];
      }
    }
    return out;
  },
});
export const chatSessionsByWorktree = _chats.store;

/** Which chat owns the keyboard: the visible one in tabs layout, the focused
 *  cell in grid layout. Persisted so re-selection lands where you left off. */
const _focusedChat = createWorktreeMap<string>({ persistKey: "trickshot.focusedChat" });
export const focusedChatByWorktree = _focusedChat.store;
/** The selected worktree's focused chat id. */
export const activeFocusedChat = _focusedChat.active<string>(DEFAULT_CHAT_ID);

/** GRID mosaic per worktree: the binary split tree behind right-click →
 *  split up/down/left/right (splitTree.ts owns the pure ops). Persisted so
 *  the mosaic survives restarts; renders go through splitTree.heal, which
 *  prunes leaves whose chat closed and places chats added outside a split
 *  (tab-strip +, palette) — so this store never has to chase removeChat. */
const _splits = createWorktreeMap<SplitNode>({
  persistKey: "trickshot.chatSplits",
  parse: (raw) => {
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) return {};
    const out: Record<string, SplitNode> = {};
    for (const [wt, tree] of Object.entries(v)) {
      if (isSplitNode(tree)) out[wt] = tree;
    }
    return out;
  },
});
export const chatSplitByWorktree = _splits.store;

/** Right-click → split: a NEW chat takes the chosen half of the target cell.
 *  Splitting from tabs layout jumps to grid (that's where the halves show). */
export function splitChat(worktree: string, targetChat: string, where: SplitWhere): ChatSession {
  const before = (get(chatSessionsByWorktree)[worktree] ?? []).map((c) => c.id);
  const chat = addChat(worktree);
  _splits.update(worktree, (tree) => {
    const healed = heal(tree, before) ?? { chat: targetChat };
    return splitLeaf(healed, targetChat, where, chat.id);
  });
  setChatLayout("grid");
  return chat;
}

/** Drag-and-drop rearrange: MOVE the dragged chat into the chosen half of
 *  the target cell (its old slot collapses to the sibling). Heals first so
 *  the move operates on the SAME tree the grid is rendering. */
export function moveChat(worktree: string, source: string, target: string, where: SplitWhere) {
  const ids = (get(chatSessionsByWorktree)[worktree] ?? []).map((c) => c.id);
  const healed = heal(get(chatSplitByWorktree)[worktree], ids);
  if (!healed) return; // no chats — nothing to rearrange
  _splits.set(worktree, moveLeaf(healed, source, target, where));
}

/** How multiple chats render: a tab strip showing one, or an n-up grid
 *  showing all. Presentation only — the chats store is layout-agnostic. */
export type ChatLayout = "tabs" | "grid";
export const chatLayout = createPersistedString("trickshot.chatLayout", "tabs", (raw) =>
  raw === "tabs" || raw === "grid" ? raw : "tabs",
);
export function setChatLayout(v: ChatLayout) {
  chatLayout.set(v);
}

/** Seed a worktree's chat list with the default chat if it has none; returns
 *  the (post-seed) list. Idempotent — the surface calls it on render. */
export function ensureDefaultChat(worktree: string): ChatSession[] {
  const cur = get(chatSessionsByWorktree)[worktree];
  if (cur?.length) return cur;
  const seeded = [{ id: DEFAULT_CHAT_ID, createdAt: Date.now() }];
  _chats.set(worktree, seeded);
  return seeded;
}

/** Add (and focus) a fresh chat. Its session id is chosen NOW (`--session-id`
 *  at first open), so the transcript identity is known from birth. */
export function addChat(worktree: string): ChatSession {
  const chat: ChatSession = {
    id: Math.random().toString(36).slice(2, 8),
    sessionId: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  _chats.update(worktree, (cur) => [...(cur ?? []), chat]);
  focusChat(worktree, chat.id);
  return chat;
}

/** Drop a chat from the list (the caller disposes its terminal/PTY first —
 *  see terminal.ts › disposeChatTerminal). Refocuses a neighbor when the
 *  focused chat closes; the last chat can't be removed (the UI hides ×). */
export function removeChat(worktree: string, id: string) {
  const cur = get(chatSessionsByWorktree)[worktree] ?? [];
  if (cur.length <= 1) return;
  const next = cur.filter((c) => c.id !== id);
  _chats.set(worktree, next);
  if ((get(focusedChatByWorktree)[worktree] ?? DEFAULT_CHAT_ID) === id) {
    const last = next[next.length - 1];
    if (last) focusChat(worktree, last.id);
  }
}

/** Focus a chat (tabs: show it; grid: route keyboard/injected turns to it). */
export function focusChat(worktree: string, id: string) {
  _focusedChat.set(worktree, id);
}

/** Pending close-chat confirmation — the modal guards EVERY close path (tab
 *  ✕, grid cell ✕, the cell context menu). null = no dialog. The dialog
 *  itself renders in ChatTabs (mounted for the whole chat surface); the
 *  confirmed action is session.ts › closeChat. */
export const chatCloseRequest = writable<{ worktree: string; chatId: string } | null>(null);
export function requestCloseChat(worktree: string, chatId: string) {
  chatCloseRequest.set({ worktree, chatId });
}
export function clearChatCloseRequest() {
  chatCloseRequest.set(null);
}

/** Record a chat's Claude session id once known (no-op when unchanged). */
export function setChatSessionId(worktree: string, chatId: string, sessionId: string) {
  _chats.update(worktree, (cur) =>
    (cur ?? []).map((c) =>
      c.id === chatId && c.sessionId !== sessionId ? { ...c, sessionId } : c,
    ),
  );
}

/** Drop a worktree's chats + focus + mosaic (worktree removal / archive purge). */
export function forgetChats(worktree: string) {
  _chats.remove(worktree);
  _focusedChat.remove(worktree);
  _splits.remove(worktree);
}

// Per-PTY-KEY chat status (the per-tab/per-cell dot). The worktree-level
// `sessionStatus` above stays the AGGREGATE (busy if any chat busy) so its
// consumers (sidebar dot, Fleet, unread gating) needed no change — the two
// write sites below maintain it.
export const chatStatusByKey = writable<Record<string, SessionStatus>>({});
/** One chat's status changed: record it per key and refresh the worktree
 *  aggregate. Keys are the claude-slot composites (`{worktree}\0claude…`), so
 *  the aggregate scans by prefix — the NUL scheme is the hand-mirrored
 *  terminal.ts/terminal.rs seam. */
export function setChatStatus(worktree: string, key: string, status: SessionStatus) {
  chatStatusByKey.update((m) => (m[key] === status ? m : { ...m, [key]: status }));
  const m = get(chatStatusByKey);
  const prefix = `${worktree}\u0000claude`;
  const statuses = Object.entries(m)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, s]) => s);
  const agg: SessionStatus = statuses.includes("busy")
    ? "busy"
    : statuses.includes("ready")
      ? "ready"
      : "stopped";
  setStatus(worktree, agg);
}
/** Drop every chat-status entry for a worktree (terminal disposal). */
export function clearChatStatuses(worktree: string) {
  const prefix = `${worktree}\u0000claude`;
  chatStatusByKey.update((m) => {
    const keys = Object.keys(m).filter((k) => k.startsWith(prefix));
    if (keys.length === 0) return m;
    const next = { ...m };
    for (const k of keys) delete next[k];
    return next;
  });
}
/** Remove a repo from trickshot's sidebar. Does NOT delete the git repo on disk —
 *  it just drops it from the app: stops any running scripts for its worktrees,
 *  removes its worktree list, and clears the selection if it pointed into the repo. */
export function removeRepo(repoPath: string) {
  const wts = get(worktreesByRepo)[repoPath] ?? [];
  const sel = get(selectedWorktree);
  for (const wt of wts) {
    api.stopScript(wt.path);
    clearStatus(wt.path);
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
// scriptEvents.ts) so a chatty build log is one store write per flush, not per line.
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
// Conductor-style archive: the worktree DIR is removed (branch kept). Claude
// Code's own session store is keyed by the worktree path, and the path scheme
// is deterministic (`../.<repo>-worktrees/<branch>`), so restoring the branch
// recreates the same path and the CLI resumes the same conversation. This list
// is just the sidebar's "History" index of those parked workspaces.
export interface ArchivedWorkspace {
  repoPath: string;
  repoName: string;
  branch: string;
  /** The worktree path at archive time (Claude Code's session-store key). */
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

// ---- Per-worktree provider (persisted) ----
// Which provider's CLI a worktree's chat runs. There is no picker yet (Claude
// is the only provider); the store exists so every provider-scoped consumer
// (the usage/auth probes, error copy) already reads through it instead of
// assuming Claude.
const _provider = createWorktreeMap<string>({ persistKey: "trickshot.providerByWorktree" });
export const providerByWorktree = _provider.store;
/** Switch a worktree's provider (no-op when unchanged). */
export function setWorktreeProvider(worktree: string, id: string) {
  if ((get(providerByWorktree)[worktree] ?? DEFAULT_PROVIDER_ID) === id) return;
  _provider.set(worktree, id);
}
/** The selected worktree's provider id (default provider when unset). */
export const activeProvider = _provider.active<string>(DEFAULT_PROVIDER_ID);

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
  { id: "sf-mono", label: "SF Mono (terminal)" },
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

/** Terminal (CLI chat + shell) font size in px, persisted and clamped. The
 *  primary surface is a terminal, so its size deserves a knob; applied live by
 *  `terminal.ts › applyTerminalFontSize` (called from Settings — terminal.ts
 *  must not subscribe at module eval, see its CIRCULAR-IMPORT CONTRACT). */
export const TERMINAL_FONT_SIZES = [11, 12, 13, 14, 15, 16] as const;
export const terminalFontSize = createPersisted<number>("trickshot.terminalFontSize", 12, {
  parse: (raw) => {
    const v = Number(raw);
    return TERMINAL_FONT_SIZES.some((s) => s === v) ? v : 12;
  },
  serialize: String,
});
export function setTerminalFontSize(px: number) {
  if (TERMINAL_FONT_SIZES.some((s) => s === px)) terminalFontSize.set(px);
}
// The terminal size doubles as the uniform-type size (below) — expose it to
// CSS as `--app-uniform-size` so the override block tracks the setting live.
terminalFontSize.subscribe((px) => {
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("--app-uniform-size", `${px}px`);
  }
});

/** Uniform type: render EVERY `--text-*` step at the terminal font size — a
 *  real TUI has exactly one glyph size, so this is the last notch of the
 *  terminal aesthetic. Reflects to `<html data-uniform-type>`; the override
 *  block lives in app.css. Persisted. */
export const uniformType = createPersisted<boolean>("trickshot.uniformType", false, {
  parse: (raw) => raw === "true",
  serialize: String,
});
uniformType.subscribe((on) => {
  if (typeof document !== "undefined") {
    if (on) document.documentElement.dataset.uniformType = "";
    else delete document.documentElement.dataset.uniformType;
  }
});
export function setUniformType(v: boolean) {
  uniformType.set(v);
}

/** Cursor trail: the terminal-backdrop pointer effect (cursorTrail.ts). On by
 *  default; App.svelte gates the trail node on this. Persisted. */
export const cursorTrailEnabled = createPersisted<boolean>("trickshot.cursorTrail", true, {
  parse: (raw) => raw === "true",
  serialize: String,
});
export function setCursorTrailEnabled(v: boolean) {
  cursorTrailEnabled.set(v);
}

// ---- Session/worktree orchestration ----
// Opening a repo, activating a worktree's CLI chat, and handing prompts to the
// TUI live in `session.ts` (the scriptEvents.ts precedent); re-export so
// `import { activateWorktree } from "./stores"` keeps working.
export {
  activateWorktree,
  closeChat,
  ensureClaudeOpen,
  handleCliExit,
  openRepository,
  restoreWorkspace,
  sendToCli,
  submitTurnToChat,
} from "./session";

// ---- Derived "active" views (the SELECTED worktree's value, via the factory) ----
/** The selected worktree's change summary (null until fetched / when none). */
export const activeGitStat = _gitStat.active(null);
/** The selected worktree's script run (null until one is launched). */
export const activeScriptRun = _scriptRun.active(null);
/** The owning repo's scripts config (null until fetched / no repo). */
export const activeScripts = derived([scriptsByRepo, activeRepo], ([$cfg, $repo]) =>
  $repo ? ($cfg[$repo.path] ?? null) : null,
);
