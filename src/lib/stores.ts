import { writable, derived } from "svelte/store";
import type { ModelInfo, Repo, SDKMessageLike, Worktree } from "./types";

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

// ---- Models ----
// The switchable-model catalog is the same across worktrees (one Claude binary),
// so it's a single global list; the *current* model is per-worktree.
export const availableModels = writable<ModelInfo[]>([]);

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
const TRANSCRIPTS_KEY = "trickshot.transcripts";
function loadTranscripts(): Record<string, SDKMessageLike[]> {
  if (!hasLS) return {};
  try {
    const v = JSON.parse(localStorage.getItem(TRANSCRIPTS_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
const _loaded = loadTranscripts();
export const transcripts = writable<Record<string, SDKMessageLike[]>>(_loaded);

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
/** The current model of the selected worktree's chat (null until its session
 *  reports a `models` event). */
export const activeModel = derived(
  [modelByWorktree, selectedWorktree],
  ([$m, $sel]) => ($sel ? ($m[$sel] ?? null) : null),
);
/** The selected worktree's current agent activity (null when idle). */
export const activeActivity = derived(
  [worktreeActivity, selectedWorktree],
  ([$a, $sel]) => ($sel ? ($a[$sel] ?? null) : null),
);
