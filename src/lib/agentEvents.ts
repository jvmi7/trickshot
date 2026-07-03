// The agent-event router — the app's central reducer over the sidecar stream,
// split out of App.svelte so it's plain, testable TypeScript instead of logic
// buried in an onMount closure. `handleAgentEvent` dispatches one parsed `Outbound`
// to the stores; `handleSessionStatus` handles OS-level session lifecycle. App.svelte
// just wires these into `api.onAgentEvent`. The `never` exhaustiveness guard here is
// the webview half of the SYNC RULE (a new Outbound `kind` is a compile error).

import { get } from "svelte/store";
import { toolDetail, toolLabel } from "./agentMessage";
import { notify, requestSuggestions, setModel, toggleConnector } from "./api";
import {
  appendCommentDelta,
  appendMessage,
  authState,
  bumpGitRefresh,
  bumpUnread,
  clearActivity,
  clearSuggestions,
  consumeSuppressDrain,
  globalConnectorPrefs,
  maybeDrainQueued,
  modelByWorktree,
  recentConversation,
  refreshUsage,
  selectedWorktree,
  setActivity,
  setAvailableCommands,
  setAvailableModels,
  setCommentError,
  setCommentPending,
  setConnectors,
  setMcpStatus,
  setPendingPermission,
  setPendingQuestion,
  setStatus,
  setSuggestions,
  setTurnSummary,
  setWorktreeModel,
  setWorktreeSession,
  worktreeActivity,
} from "./stores";
import type { AgentMessage, Outbound } from "./types";
import { basename } from "./utils";

/** Does an agent/sidecar error text read like a Claude Code auth failure?
 *  Pure and deliberately loose — matching costs a friendlier message; a false
 *  negative costs the raw SDK error the user would have seen anyway. */
export function isAuthError(text: string): boolean {
  return /log ?in|logged|authenticat|oauth|api key|credential|401|unauthorized/i.test(text);
}

/** The friendly substitute for a raw auth-failure error (Welcome/Chat show the
 *  matching ambient banner via `authState`). */
const AUTH_ERROR_MESSAGE =
  "not signed in to Claude Code — run `claude` in a terminal, then click the worktree to restart";

// Recognize an auth failure: swap the cryptic raw text for actionable copy and
// flip the ambient auth state so the sign-in banner appears above the composer.
function appendErrorMessage(worktree: string, raw: string) {
  if (isAuthError(raw)) {
    authState.set("missing");
    appendMessage(worktree, { type: "error", error: AUTH_ERROR_MESSAGE });
  } else {
    appendMessage(worktree, { type: "error", error: raw });
  }
}

// Turn each neutral message into a human-readable "what's happening now" for the
// chat's loading footer.
function updateActivity(worktree: string, m: AgentMessage) {
  if (m.type === "tool_call") {
    setActivity(worktree, toolLabel(m.name), toolDetail(m.name, m.input), true);
  } else if (m.type === "assistant") {
    setActivity(worktree, "Writing response", "");
  } else if (m.type === "tool_result") {
    // a tool result came back — the agent is reasoning again
    setActivity(worktree, "Thinking", "");
  } else if (m.type === "system") {
    setActivity(worktree, "Connecting", "");
  }
}

/** Handle one parsed protocol message (tagged with its worktree) — the single
 *  consumer of the `Outbound` union. */
export function handleAgentEvent(worktree: string, evt: Outbound) {
  if (evt.kind === "message") {
    const m = evt.message;
    updateActivity(worktree, m);
    // `turn_end` ends the turn — the agent is idle again (not rendered).
    // `system` is a session notice we don't render. Everything else is a
    // transcript bubble.
    if (m.type === "turn_end") {
      setStatus(worktree, "ready");
      // Stash an end-of-turn summary (Claude-Code style) for the loading
      // footer to show while idle: how long the turn took + tool-call count.
      const act = get(worktreeActivity)[worktree];
      if (act) {
        const seconds = Math.max(0, Math.floor((Date.now() - act.startedAt) / 1000));
        setTurnSummary(worktree, { seconds, steps: act.steps });
      }
      clearActivity(worktree);
      // A turn just consumed subscription budget — refresh the usage
      // windows (throttled; the endpoint is rate-limited, see stores).
      refreshUsage();
      // The turn likely touched files — refresh an open git panel.
      bumpGitRefresh();
      // Queued follow-ups drain ONE per turn: if this worktree has a queued
      // message, send it now as the next turn and skip the "finished"
      // side-effects below (unread/notify/suggestions) — the agent isn't done,
      // it's continuing. Each follow-up's own turn_end drains the next. A Stop
      // interrupt also produces a turn_end; consumeSuppressDrain() makes that one
      // halt cleanly (no drain), leaving the queue for manual sending.
      if (!consumeSuppressDrain(worktree) && maybeDrainQueued(worktree)) return;
      // If this worktree isn't the one on screen, flag it + notify so the
      // user notices a background agent finishing.
      if (worktree !== get(selectedWorktree)) {
        bumpUnread(worktree);
        void notify("Agent finished", basename(worktree));
      } else {
        // Offer suggested next replies for the on-screen chat only — it's a
        // cheap extra model call, so don't spend it on background worktrees.
        // Clear the old set first so stale chips don't linger while we wait.
        clearSuggestions(worktree);
        const convo = recentConversation(worktree);
        if (convo) requestSuggestions(worktree, convo);
      }
    } else if (m.type !== "system") {
      appendMessage(worktree, m);
    }
  } else if (evt.kind === "session") {
    // Persist the resumable session id so this worktree's agent *context*
    // can be restored after a restart (the provider reports it once known).
    setWorktreeSession(worktree, evt.id);
  } else if (evt.kind === "permission_request") {
    setPendingPermission(worktree, { id: evt.id, tool: evt.tool, input: evt.input });
  } else if (evt.kind === "question_request") {
    setPendingQuestion(worktree, { id: evt.id, questions: evt.questions });
  } else if (evt.kind === "suggestions") {
    // Suggested next replies arrived (answer to a `suggest` request).
    setSuggestions(worktree, evt.suggestions);
  } else if (evt.kind === "comment_reply") {
    // Out-of-band inline-comment answer (streamed). Routed ONLY to the comment
    // thread's store — deliberately NOT to the transcript/status/usage, so a
    // comment never affects the main chat (the whole point of the feature).
    if (evt.error) setCommentError(worktree, evt.id, evt.error);
    else if (evt.delta) appendCommentDelta(worktree, evt.id, evt.delta);
    if (evt.done && !evt.error) setCommentPending(worktree, evt.id, false);
  } else if (evt.kind === "commands") {
    setAvailableCommands(evt.commands);
  } else if (evt.kind === "mcp_status") {
    setMcpStatus(evt.servers);
  } else if (evt.kind === "notification") {
    // Agent wants attention — raise an OS notification if it's not the
    // worktree currently on screen.
    if (worktree !== get(selectedWorktree)) {
      void notify(basename(worktree), evt.message);
    }
  } else if (evt.kind === "error") {
    // Surface only. Status is deliberately NOT reset here: this channel is
    // shared by FATAL errors (an agent-loop throw, which then exits → the
    // `terminated` event below unsticks the session) and NON-FATAL ones
    // (e.g. a setModel failure while the turn keeps streaming, which must
    // stay `busy`). Resetting here would wrongly unstick a live turn.
    appendErrorMessage(worktree, evt.error);
  } else if (evt.kind === "ready") {
    setStatus(worktree, "ready");
  } else if (evt.kind === "connectors") {
    setConnectors(worktree, evt.servers);
    // Re-apply the GLOBAL connector preferences live (the SDK's toggle is
    // not remembered across sessions). Toggle any connector whose live state
    // differs from the saved preference. Toggling re-publishes `connectors`;
    // the state then matches, so this converges (no toggle loop).
    const g = get(globalConnectorPrefs);
    for (const s of evt.servers) {
      const want = g[s.name];
      if (want === undefined) continue;
      const isOn = s.status !== "disabled";
      if (want !== isOn) toggleConnector(worktree, s.name, want);
    }
  } else if (evt.kind === "models") {
    setAvailableModels(evt.models);
    // Each sidecar starts on the default model. If this worktree has a
    // persisted choice that differs (and is still offered), re-apply it;
    // otherwise adopt the sidecar's confirmed current as truth.
    const chosen = get(modelByWorktree)[worktree];
    const known = evt.models.some((m) => m.value === chosen);
    if (chosen && known && chosen !== evt.current) {
      setModel(worktree, chosen);
    } else {
      setWorktreeModel(worktree, evt.current);
    }
  } else {
    // Exhaustiveness: a new Outbound `kind` left unhandled here is a compile
    // error (svelte-check / check:sidecar) — the webview half of the SYNC RULE.
    const _exhaustive: never = evt;
    void _exhaustive;
  }
}

/** Handle OS-level session lifecycle: a terminate OR a spawn/IO error stops the
 *  session. `data` carries diagnostics (including the buffered stderr tail) for an
 *  error or abnormal exit; it's null for a clean shutdown (stays quiet). */
export function handleSessionStatus(
  worktree: string,
  kind: "terminated" | "error",
  data: string | null,
) {
  setStatus(worktree, "stopped");
  clearActivity(worktree);
  if (kind === "error") {
    if (data) appendErrorMessage(worktree, `session error: ${data}`);
    else appendMessage(worktree, { type: "error", error: "session error" });
  } else if (data) {
    appendErrorMessage(worktree, data);
  }
}
