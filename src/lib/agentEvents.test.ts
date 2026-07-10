import { describe, expect, spyOn, test } from "bun:test";
import { get } from "svelte/store";
import { handleAgentEvent, handleSessionStatus } from "./agentEvents";
import * as api from "./api";
import { providerDisplay } from "./providers";
import {
  authState,
  availableModels,
  connectorsByWorktree,
  modelByWorktree,
  modelsByWorktree,
  pendingPermission,
  pendingQuestion,
  selectedWorktree,
  sessionByWorktree,
  sessionStatus,
  setGlobalConnectorPref,
  setWorktreeModel,
  transcripts,
  turnSummary,
  worktreeActivity,
} from "./stores";

// A fresh worktree key per test so store state never collides across tests.
let n = 0;
const wt = () => `agentEvents-test-${n++}`;
const tick = () => new Promise((r) => setTimeout(r, 25)); // > the 16ms append flush

describe("handleAgentEvent dispatch", () => {
  test("ready → session status becomes ready", () => {
    const w = wt();
    handleAgentEvent(w, { kind: "ready" });
    expect(get(sessionStatus)[w]).toBe("ready");
  });

  test("session → the resumable id is persisted", () => {
    const w = wt();
    handleAgentEvent(w, { kind: "session", id: "sess-123" });
    expect(get(sessionByWorktree)[w]).toBe("sess-123");
  });

  test("permission_request → pending permission is set", () => {
    const w = wt();
    handleAgentEvent(w, { kind: "permission_request", id: "p1", tool: "Bash", input: { a: 1 } });
    expect(get(pendingPermission)[w]).toEqual({ id: "p1", tool: "Bash", input: { a: 1 } });
  });

  test("question_request → pending question is set", () => {
    const w = wt();
    const questions = [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }];
    handleAgentEvent(w, { kind: "question_request", id: "q1", questions });
    expect(get(pendingQuestion)[w]).toEqual({ id: "q1", questions });
  });

  test("an assistant message is appended to the transcript", async () => {
    const w = wt();
    handleAgentEvent(w, { kind: "message", message: { type: "assistant", text: "hello" } });
    await tick();
    const msgs = get(transcripts)[w] ?? [];
    expect(msgs.at(-1)).toMatchObject({ type: "assistant", text: "hello" });
  });

  test("a stream error is appended as an error bubble (status untouched)", async () => {
    const w = wt();
    handleAgentEvent(w, { kind: "ready" });
    handleAgentEvent(w, { kind: "error", error: "boom" });
    await tick();
    expect(get(transcripts)[w]?.at(-1)).toMatchObject({ type: "error", error: "boom" });
    // The error channel must NOT unstick the session (it may be a non-fatal error
    // mid-turn) — status stays whatever it was.
    expect(get(sessionStatus)[w]).toBe("ready");
  });
});

describe("handleAgentEvent — models", () => {
  test("publishes the catalog PER WORKTREE and adopts current when no persisted choice differs", () => {
    const w = wt();
    const models = [
      { value: "m1", displayName: "M1" },
      { value: "m2", displayName: "M2" },
    ];
    handleAgentEvent(w, { kind: "models", models, current: "m2" });
    // The catalog lands under the EMITTING worktree (concurrent sessions must not
    // clobber each other)…
    expect(get(modelsByWorktree)[w]).toEqual(models);
    // …and `availableModels` is the selected worktree's view of it.
    selectedWorktree.set(w);
    expect(get(availableModels)).toEqual(models);
    // No persisted choice for this fresh worktree → adopt the sidecar's current.
    expect(get(modelByWorktree)[w]).toBe("m2");
  });

  test("one session's catalog does not clobber another's", () => {
    const a = wt();
    const b = wt();
    handleAgentEvent(a, {
      kind: "models",
      models: [{ value: "a1", displayName: "A1" }],
      current: "a1",
    });
    handleAgentEvent(b, {
      kind: "models",
      models: [{ value: "b1", displayName: "B1" }],
      current: "b1",
    });
    expect(get(modelsByWorktree)[a]).toEqual([{ value: "a1", displayName: "A1" }]);
    expect(get(modelsByWorktree)[b]).toEqual([{ value: "b1", displayName: "B1" }]);
  });
});

describe("handleAgentEvent — models (re-apply persisted choice)", () => {
  test("re-applies a differing persisted choice instead of adopting current", () => {
    const w = wt();
    const spy = spyOn(api, "setModel").mockResolvedValue(undefined);
    // Persisted choice differs from the sidecar's reported current.
    setWorktreeModel(w, "m1");
    const models = [
      { value: "m1", displayName: "M1" },
      { value: "m2", displayName: "M2" },
    ];
    handleAgentEvent(w, { kind: "models", models, current: "m2" });
    // The convergence branch re-applies the saved choice via the live command…
    expect(spy).toHaveBeenCalledWith(w, "m1");
    // …and does NOT overwrite the store with `current` (the sidecar will confirm
    // by re-emitting `models` with the updated current).
    expect(get(modelByWorktree)[w]).toBe("m1");
    spy.mockRestore();
  });
});

describe("handleAgentEvent — connectors", () => {
  test("stores the connector list; toggles nothing when no preference is set", () => {
    const w = wt();
    const servers = [{ name: "fs", status: "connected" as const, tools: [] }];
    handleAgentEvent(w, { kind: "connectors", servers });
    // want === undefined for every server (no global pref) → setConnectors only.
    expect(get(connectorsByWorktree)[w]).toEqual(servers);
  });

  test("toggles a connector whose live state differs from the saved preference", () => {
    const w = wt();
    const spy = spyOn(api, "toggleConnector").mockResolvedValue(undefined);
    // Unique name so the global (connector-name-keyed) pref can't leak into the
    // sibling test above. Saved pref says OFF, but the server reports it ON.
    const name = "conv-test-connector";
    setGlobalConnectorPref(name, false);
    handleAgentEvent(w, {
      kind: "connectors",
      servers: [{ name, status: "connected", tools: [] }],
    });
    expect(spy).toHaveBeenCalledWith(w, name, false);
    spy.mockRestore();
  });
});

describe("handleAgentEvent — turn_end", () => {
  test("ends the turn: ready status, a summary from activity, activity cleared", () => {
    const w = wt();
    // Foreground path (selected) so no OS notification / background unread fires.
    selectedWorktree.set(w);
    // A tool_call seeds the activity (a step + startedAt) that the summary reads.
    handleAgentEvent(w, {
      kind: "message",
      message: { type: "tool_call", id: "t1", name: "Bash", input: {} },
    });
    handleAgentEvent(w, { kind: "message", message: { type: "turn_end" } });
    expect(get(sessionStatus)[w]).toBe("ready");
    expect(get(turnSummary)[w]).toMatchObject({ steps: 1 });
    expect(get(worktreeActivity)[w]).toBeUndefined(); // cleared on turn end
  });
});

describe("handleSessionStatus", () => {
  test("a terminate stops the session; a null payload appends no bubble", async () => {
    const w = wt();
    handleAgentEvent(w, { kind: "ready" });
    handleSessionStatus(w, "terminated", null);
    await tick();
    expect(get(sessionStatus)[w]).toBe("stopped");
    expect(get(transcripts)[w] ?? []).toHaveLength(0);
  });

  test("an error with a payload appends a session-error bubble", async () => {
    const w = wt();
    handleSessionStatus(w, "error", "spawn failed");
    await tick();
    expect(get(transcripts)[w]?.at(-1)).toMatchObject({
      type: "error",
      error: "session error: spawn failed",
    });
    expect(get(sessionStatus)[w]).toBe("stopped");
  });

  test("an auth-flavored death is swapped for the friendly sign-in bubble + authState", async () => {
    const w = wt();
    authState.set("unknown");
    handleSessionStatus(
      w,
      "terminated",
      "sidecar exited (code 1)\nOAuth token expired · Please run /login",
    );
    await tick();
    expect(get(transcripts)[w]?.at(-1)).toMatchObject({
      type: "error",
      error: expect.stringContaining("not signed in to Claude Code"),
    });
    expect(get(authState)).toBe("missing");
    authState.set("unknown");
  });
});

describe("provider auth-error matching (providers.ts)", () => {
  const isAuthError = (text: string) => providerDisplay("claude").authErrorPattern.test(text);

  test("matches SDK-style auth failures", () => {
    expect(isAuthError("Invalid API key · Please run /login")).toBe(true);
    expect(isAuthError("OAuth token has expired")).toBe(true);
    expect(isAuthError("Not logged in")).toBe(true);
    expect(isAuthError("401 Unauthorized")).toBe(true);
    expect(isAuthError("could not read credentials")).toBe(true);
    expect(isAuthError("Authentication failed")).toBe(true);
  });

  test("leaves generic errors alone", () => {
    expect(isAuthError("ENOENT: no such file or directory")).toBe(false);
    expect(isAuthError("rate limit exceeded, retry later")).toBe(false);
    expect(isAuthError("sidecar exited (code 137)")).toBe(false);
    expect(isAuthError("TypeError: cannot read properties of undefined")).toBe(false);
  });

  test("an unknown provider id falls back to the default display", () => {
    expect(providerDisplay("no-such-provider").id).toBe("claude");
    expect(providerDisplay(undefined).id).toBe("claude");
  });
});
