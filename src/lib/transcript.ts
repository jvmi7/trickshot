// MOSTLY DEPRECATED (GUI chat surface) — under CHAT_SURFACE === "cli"
// (stores.ts) nothing WRITES transcripts (appendMessage has no live caller), so
// the batching/flush/save machinery is dormant. Still LIVE: the boot-time
// load/migration of persisted transcripts and `resetTranscript` (worktree
// removal/archive). See CLAUDE.md › "Deprecated GUI surface" before extending.
//
// The transcript engine — a self-contained subsystem split out of stores.ts so
// its invariants live (and can be tested) in one place. It owns the per-worktree
// message log: the batched/persisted `transcripts` writable, the append/reset
// mutators, and the PURE windowing/grouping/indexing helpers the selected-worktree
// derived views in stores.ts build on. See CLAUDE.md → PERFORMANCE: the batching,
// windowing, and identity-keyed grouping here are load-bearing, not optional.

import { writable } from "svelte/store";
import type { TranscriptMessage } from "./types";

// ---- Per-worktree transcripts (batched appends, persisted) ----
// A burst of streamed lines coalesces into one store write per 16ms across all
// worktrees. Each message gets a stable `__key` for identity-keyed {#each}.
// Transcripts persist to localStorage so chat history survives restarts (resume
// restores agent context but not the rendered messages — see CLAUDE.md).
// `.v3`: ONE key PER WORKTREE (`trickshot.transcript.v3.<worktree path>`)
// replaces the old v2 whole-map blob, so the idle save serializes only the
// worktrees that changed since the last save (dirty-tracked below) — O(changed
// transcripts) per save instead of O(total history) against the shared ~5MB
// quota. The v2 blob is split into per-worktree keys once on load and removed
// (best-effort, quota-tolerant); `.v2` itself had bumped the message shape (raw
// SDK messages -> the neutral AgentMessage schema), so anything older is dropped.
const V3_PREFIX = "trickshot.transcript.v3.";
const LEGACY_V2_KEY = "trickshot.transcripts.v2";

/** The per-worktree localStorage key (exported for the persistence tests). */
export function transcriptKey(worktree: string): string {
  return V3_PREFIX + worktree;
}

/** The slice of the Storage API the persistence here uses. The migrate/load/save
 *  helpers take it as a parameter so they're unit-testable against an in-memory
 *  shim — `bun test` has no localStorage (see transcript.test.ts). */
export type TranscriptStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

/** localStorage, resolved at CALL time — deliberately NOT captured at module eval
 *  like the persisted-store template (persist.ts): the save/reset wiring below
 *  must pick up the shim transcript.test.ts installs after this module loads. */
function storage(): TranscriptStorage | null {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

/** One-time v2 → v3 migration: split the old whole-map blob into per-worktree
 *  keys and remove it. Best-effort and quota-tolerant — a worktree whose write
 *  fails is dropped (the old quota behavior, per transcript instead of all-or-
 *  nothing); the v2 key is removed regardless so the split never re-runs against
 *  half-migrated state. */
export function migrateTranscriptsV2(storage: TranscriptStorage): void {
  const raw = storage.getItem(LEGACY_V2_KEY);
  if (raw === null) return;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [wt, list] of Object.entries(v)) {
        if (!Array.isArray(list) || list.length === 0) continue;
        try {
          storage.setItem(transcriptKey(wt), JSON.stringify(list));
        } catch {
          /* quota — drop this worktree's history, keep migrating the rest */
        }
      }
    }
  } catch {
    /* corrupt v2 blob — nothing to migrate */
  }
  storage.removeItem(LEGACY_V2_KEY);
}

/** Load every persisted transcript by enumerating the per-worktree key prefix.
 *  A corrupt entry is skipped — guard and fall back, never throw (the persisted-
 *  store template's rule). */
export function loadTranscripts(storage: TranscriptStorage): Record<string, TranscriptMessage[]> {
  const out: Record<string, TranscriptMessage[]> = {};
  // Collect keys first: mutating during an index walk would skew `key(i)`.
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(V3_PREFIX)) keys.push(k);
  }
  for (const k of keys) {
    try {
      const v = JSON.parse(storage.getItem(k) ?? "null");
      if (Array.isArray(v)) out[k.slice(V3_PREFIX.length)] = v;
    } catch {
      /* corrupt entry — skip just this worktree */
    }
  }
  return out;
}

/** Write each dirty worktree's transcript under its own key. Each setItem is
 *  individually quota-guarded so one over-quota transcript can't block the rest
 *  from persisting. */
export function saveDirtyTranscripts(
  storage: TranscriptStorage,
  map: Record<string, TranscriptMessage[]>,
  dirty: Iterable<string>,
): void {
  for (const wt of dirty) {
    const list = map[wt];
    if (!list || list.length === 0) continue;
    try {
      storage.setItem(transcriptKey(wt), JSON.stringify(list));
    } catch {
      /* ignore quota errors — history just won't persist past the limit */
    }
  }
}

const _boot = storage();
if (_boot) migrateTranscriptsV2(_boot);
const _loaded = _boot ? loadTranscripts(_boot) : {};
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

// Persist on idle (debounced, reset on each change) so we never serialize
// mid-stream — only ~600ms after a burst settles — and save ONLY the worktrees
// whose transcripts changed since the last save (`_dirty`, marked by flush()).
const SAVE_IDLE_MS = 600;
let _latest = _loaded;
transcripts.subscribe((t) => {
  _latest = t;
});
const _dirty = new Set<string>();
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const s = storage();
    if (s) saveDirtyTranscripts(s, _latest, _dirty);
    _dirty.clear();
  }, SAVE_IDLE_MS);
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
      _dirty.add(k);
    }
    return next;
  });
  scheduleSave();
}

/** Append a message to a worktree's transcript (stable key + batched write). */
export function appendMessage(worktree: string, msg: TranscriptMessage) {
  (msg as { __key?: number }).__key = _key++;
  (_buffers[worktree] ??= []).push(msg);
  if (_flushTimer === null) _flushTimer = setTimeout(flush, 16);
}

/** Clear a worktree's transcript and drop any buffered (un-flushed) messages.
 *  Also removes the worktree's persisted key immediately (and un-dirties it, so a
 *  pending idle save can't resurrect it) — a recreated worktree at the same path
 *  must not rehydrate the stale history. */
export function resetTranscript(worktree: string) {
  delete _buffers[worktree];
  _dirty.delete(worktree);
  storage()?.removeItem(transcriptKey(worktree));
  transcripts.update((t) => ({ ...t, [worktree]: [] }));
}

/** A worktree's not-yet-flushed messages (empty when none). Lets a reader see the
 *  just-appended burst before the 16ms flush lands it in the `transcripts` store. */
export function bufferedMessages(worktree: string): TranscriptMessage[] {
  return _buffers[worktree] ?? [];
}

// ---- Transcript windowing (bound the DOM) ----
// A transcript only grows (except on resetTranscript), and naive full-mount tops
// out at ~hundreds of messages (see CLAUDE.md PERFORMANCE). Chat mounts only the
// newest RENDER_WINDOW messages; older ones stay in the persisted transcript but
// out of the DOM. Identity-keyed `{#each}` means windowing just drops the top
// node and adds a bottom one per append. Measure before raising this.
export const RENDER_WINDOW = 300;

/** The newest `window` messages of a transcript — what Chat actually mounts. Same
 *  object identities as the input (a tail slice), so `__key` keying stays stable. */
export function windowTail<T>(msgs: T[], window = RENDER_WINDOW): T[] {
  return msgs.length > window ? msgs.slice(-window) : msgs;
}

/** How many older messages sit above the render window (0 when nothing hidden). */
export function hiddenCount(length: number, window = RENDER_WINDOW): number {
  return Math.max(0, length - window);
}

/** tool_call id → its (folded) result. Lets a tool_call row render its result
 *  inline; the standalone tool_result bubble is then suppressed in Message.svelte. */
export function indexToolResults(
  msgs: TranscriptMessage[],
): Record<string, { content: string; isError: boolean }> {
  const map: Record<string, { content: string; isError: boolean }> = {};
  for (const msg of msgs) {
    if (msg.type === "tool_result") map[msg.id] = { content: msg.content, isError: !!msg.isError };
  }
  return map;
}

// ---- Tool-call grouping (batch consecutive tool activity) ----
// A turn can fire dozens of tool calls; rendering one row each spams the chat.
// We bundle a maximal RUN of tool messages (tool_call + tool_result, no prose in
// between) into one collapsible group (see ToolGroup.svelte). `tool_result`s are
// folded into their call (indexToolResults) and don't render, but they DON'T break
// a run. Everything else (assistant/user_local/system/error) is its own group.
type ToolCallMsg = Extract<TranscriptMessage, { type: "tool_call" }>;
export type RenderedGroup =
  | { kind: "single"; key: string; message: TranscriptMessage }
  | { kind: "tools"; key: string; tools: ToolCallMsg[] };

/** Collapse a (windowed) message list into render groups. Keyed stably by the
 *  first member's `__key` (prefixed) so identity-keyed `{#each}` reconciles
 *  efficiently: appending a tool call grows the open run's array (same group key),
 *  and the group's own `{#each tools (__key)}` adds just the new row. */
export function groupMessages(msgs: TranscriptMessage[]): RenderedGroup[] {
  const groups: RenderedGroup[] = [];
  let run: { kind: "tools"; key: string; tools: ToolCallMsg[] } | null = null;
  for (const m of msgs) {
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
}

/** Build a compact recent-conversation string (user + assistant turns only) from
 *  a message list, to seed suggestion generation. Caps length so the cheap suggest
 *  model stays cheap. Callers pass transcript + un-flushed buffer so the just-ended
 *  turn is present (see `recentConversation` in session.ts). */
export function summarizeConversation(
  all: TranscriptMessage[],
  maxMessages = 8,
  maxChars = 400,
): string {
  const lines: string[] = [];
  for (const m of all) {
    // `text` can be absent on an assistant message (e.g. a tool-call-only turn);
    // guard with ?? "" so summarization never throws (it's read by the comment +
    // suggestion prompt assembly — a missing field must render nothing, not throw).
    if (m.type === "user_local") lines.push(`User: ${(m.text ?? "").slice(0, maxChars)}`);
    else if (m.type === "assistant") lines.push(`Assistant: ${(m.text ?? "").slice(0, maxChars)}`);
  }
  return lines.slice(-maxMessages).join("\n");
}
