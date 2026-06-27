import { describe, expect, test } from "bun:test";
import { get } from "svelte/store";
import { handleAgentEvent, handleSessionStatus } from "./agentEvents";
import {
  pendingPermission,
  pendingQuestion,
  sessionByWorktree,
  sessionStatus,
  transcripts,
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
});
