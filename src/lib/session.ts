// Session/turn orchestration — the async flows split out of stores.ts by the
// transcript.ts precedent: submitting a user turn, the queued follow-up messages,
// building the session-start config, and the repo/worktree activation paths.
// stores.ts re-exports everything so `import { submitUserTurn } from "./stores"`
// keeps working.
//
// CIRCULAR-IMPORT CONTRACT (shared with threads.ts): this module and stores.ts
// import each other, which is safe under ESM live bindings ONLY as long as the
// sibling touches stores.ts's state lazily — `createWorktreeMap` is a hoisted
// function declaration (callable before stores.ts's body runs) and its `.active()`
// resolves `selectedWorktree` on first subscribe, so nothing here dereferences a
// stores.ts const at module-eval time. Keep it that way.

import { get } from "svelte/store";
import * as api from "./api";
import { MINIMAL_DIRECTIVE } from "./minimal";
import { DEFAULT_PROVIDER_ID } from "./providers";
import {
  addRepo,
  clearActivity,
  clearSuggestions,
  clearUnread,
  createWorktreeMap,
  DEFAULT_PERMISSION_MODE,
  getAgents,
  getMcpServers,
  minimalMode,
  permissionModeByWorktree,
  providerByWorktree,
  selectWorktree,
  sessionByWorktree,
  sessionStatus,
  setCenterView,
  setStatus,
  setWorktrees,
  startActivity,
  systemPromptAppend,
} from "./stores";
import { appendMessage, bufferedMessages, summarizeConversation, transcripts } from "./transcript";
import { basename } from "./utils";

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
    // Deliberate exception to the "command rejections stay in local component
    // state" rule: the user's bubble is already in the transcript, so the
    // failure must land NEXT TO IT or the message looks sent when it wasn't.
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
/** One queued follow-up. `id` is a stable per-app-run key (never reused), so the
 *  list can be keyed/removed by identity — index keying re-pairs DOM rows with
 *  the wrong item after a mid-list removal. */
export interface QueuedMessage {
  id: number;
  text: string;
}
let nextQueuedId = 1;
const _queued = createWorktreeMap<QueuedMessage[]>();
export const queuedByWorktree = _queued.store;
/** The selected worktree's queued follow-ups (empty when none). */
export const activeQueued = _queued.active<QueuedMessage[]>([]);
/** Append a follow-up to a worktree's queue (no-op on blank text). */
export function enqueueMessage(worktree: string, text: string) {
  const t = text.trim();
  if (!t) return;
  _queued.update(worktree, (cur) => [...(cur ?? []), { id: nextQueuedId++, text: t }]);
}
/** Drop one queued message by its stable id (the per-item remove). */
export function removeQueued(worktree: string, id: number) {
  _queued.update(worktree, (cur) => (cur ?? []).filter((q) => q.id !== id));
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
  void submitUserTurn(worktree, next.text); // sets busy + optimistic bubble + IPC
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
    provider: get(providerByWorktree)[worktree] ?? DEFAULT_PROVIDER_ID,
    resumeSessionId: get(sessionByWorktree)[worktree],
    permissionMode: get(permissionModeByWorktree)[worktree] ?? DEFAULT_PERMISSION_MODE,
    systemPromptAppend: get(systemPromptAppend),
    mcpServers: getMcpServers(),
    agents: getAgents(),
  });
}

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

/** Activate a worktree: select it, return the center pane to the chat, clear
 *  its unread badge, and (re)start its session. The ONE activation path — the
 *  sidebar row and the command palette both route through here. Throws on a
 *  session-start failure so callers surface it in their local error state. */
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
