import { writable, derived } from "svelte/store";
import type { Repo, SDKMessageLike, Worktree } from "./types";

export interface PermissionReq {
  id: string;
  tool: string;
  input: unknown;
}

export type SessionStatus = "running" | "working" | "stopped";

const hasLS = typeof localStorage !== "undefined";

// ---- UI state ----
/** Whether the left sidebar is visible. Toggled from the global header. */
export const sidebarOpen = writable<boolean>(true);

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

// ---- Per-worktree transcripts (batched appends) ----
// A burst of streamed lines coalesces into one store write per 16ms across all
// worktrees. Each message gets a stable `__key` for identity-keyed {#each}.
export const transcripts = writable<Record<string, SDKMessageLike[]>>({});

let _key = 0;
const _buffers: Record<string, SDKMessageLike[]> = {};
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  _flushTimer = null;
  const keys = Object.keys(_buffers);
  if (keys.length === 0) return;
  transcripts.update((t) => {
    const next = { ...t };
    for (const k of keys) {
      next[k] = (next[k] ?? []).concat(_buffers[k]);
      delete _buffers[k];
    }
    return next;
  });
}

/** Append a message to a worktree's transcript (stable key + batched write). */
export function appendMessage(worktree: string, msg: SDKMessageLike) {
  (msg as { __key?: number }).__key = _key++;
  (_buffers[worktree] ??= []).push(msg);
  if (_flushTimer === null) _flushTimer = setTimeout(flush, 16);
}

/** Clear a worktree's transcript and drop any buffered (un-flushed) messages. */
export function resetTranscript(worktree: string) {
  delete _buffers[worktree];
  transcripts.update((t) => ({ ...t, [worktree]: [] }));
}

// ---- Per-worktree pending permission (dormant under bypassPermissions) ----
export const pendingPermission = writable<Record<string, PermissionReq | null>>({});

// ---- Derived views for the currently selected worktree ----
export const activeMessages = derived(
  [transcripts, selectedWorktree],
  ([$t, $sel]) => ($sel ? ($t[$sel] ?? []) : []),
);
export const activePending = derived(
  [pendingPermission, selectedWorktree],
  ([$p, $sel]) => ($sel ? ($p[$sel] ?? null) : null),
);
