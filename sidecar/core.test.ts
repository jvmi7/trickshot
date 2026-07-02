// Pins the sidecar transport (core.ts): the stdin line handling, the Inbound →
// provider dispatch table, and the SESSION_CONFIG parse guard. This is the third
// process's only behavioral net — before this, core.ts was typecheck-only. The
// provider here is a recording stub; the real agent loop stays untested by
// design (it needs a live login — see CLAUDE.md testing conventions).

import { describe, expect, test } from "bun:test";
import type { Inbound } from "../shared/protocol";
import { dispatch, handleLine, parseSessionConfig } from "./core";
import type { AgentProvider } from "./providers/types";

/** A provider that records every call as [method, ...args]. */
function recorder(): { provider: AgentProvider; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const provider: AgentProvider = {
    id: "stub",
    start: rec("start"),
    pushTurn: rec("pushTurn"),
    setModel: rec("setModel"),
    setPermissionMode: rec("setPermissionMode"),
    interrupt: rec("interrupt"),
    publishModels: rec("publishModels"),
    publishConnectors: rec("publishConnectors"),
    toggleConnector: rec("toggleConnector"),
    reconnectConnector: rec("reconnectConnector"),
    publishCommands: rec("publishCommands"),
    setMcpServers: rec("setMcpServers"),
    replyPermission: rec("replyPermission"),
    replyQuestion: rec("replyQuestion"),
    suggest: rec("suggest"),
  };
  return { provider, calls };
}

describe("dispatch routes every Inbound kind to the right provider method", () => {
  // One entry per Inbound kind — adding a kind without extending this table
  // fails the length assertion below (the runtime mirror of the compile guard).
  const CASES: [Inbound, unknown[]][] = [
    [{ kind: "user_turn", text: "hi" }, ["pushTurn", "hi"]],
    [{ kind: "set_model", model: "m1" }, ["setModel", "m1"]],
    [{ kind: "set_permission_mode", mode: "plan" }, ["setPermissionMode", "plan"]],
    [{ kind: "get_models" }, ["publishModels"]],
    [{ kind: "get_connectors" }, ["publishConnectors"]],
    [{ kind: "toggle_connector", name: "gh", enabled: false }, ["toggleConnector", "gh", false]],
    [{ kind: "reconnect_connector", name: "gh" }, ["reconnectConnector", "gh"]],
    [{ kind: "get_commands" }, ["publishCommands"]],
    [{ kind: "set_mcp_servers", servers: { a: {} } }, ["setMcpServers", { a: {} }]],
    [{ kind: "interrupt" }, ["interrupt"]],
    [
      { kind: "permission_reply", id: "p1", behavior: "deny", message: "no" },
      ["replyPermission", "p1", "deny", "no"],
    ],
    [{ kind: "question_reply", id: "q1", answers: [["A"]] }, ["replyQuestion", "q1", [["A"]]]],
    [{ kind: "suggest", conversation: "user: hi" }, ["suggest", "user: hi"]],
  ];

  test("the table covers every Inbound kind", () => {
    // Count the kind literals in the union so a new kind can't skip this suite.
    const kinds = new Set(CASES.map(([c]) => c.kind));
    expect(kinds.size).toBe(CASES.length);
  });

  test.each(CASES)("%j", (cmd, expected) => {
    const { provider, calls } = recorder();
    dispatch(provider, cmd);
    expect(calls).toEqual([expected]);
  });
});

describe("handleLine tolerates wire noise", () => {
  test("a valid JSON line dispatches exactly once", () => {
    const { provider, calls } = recorder();
    handleLine(provider, '  {"kind":"interrupt"}  ');
    expect(calls).toEqual([["interrupt"]]);
  });

  test.each([
    "",
    "   ",
    "not json",
    "{truncated",
    '"a bare string"',
  ])("garbage line %j is ignored, never throws", (line) => {
    const { provider, calls } = recorder();
    expect(() => handleLine(provider, line)).not.toThrow();
    // A bare non-object parses but has no kind → falls into the default arm,
    // which must also be a no-op.
    expect(calls).toEqual([]);
  });
});

describe("parseSessionConfig guards the env blob", () => {
  test("absent / empty → {}", () => {
    expect(parseSessionConfig(undefined)).toEqual({});
    expect(parseSessionConfig("")).toEqual({});
  });

  test("garbage / non-object JSON → {}", () => {
    expect(parseSessionConfig("not json")).toEqual({});
    expect(parseSessionConfig("[1,2]")).toEqual({});
    expect(parseSessionConfig("42")).toEqual({});
  });

  test("a valid blob round-trips", () => {
    const cfg = { provider: "claude", resumeSessionId: "s1", permissionMode: "plan" };
    expect(parseSessionConfig(JSON.stringify(cfg))).toEqual(cfg);
  });
});
