import { describe, expect, test } from "bun:test";
import { listMcpServers, summarizeClaudeSettings } from "./claudeConfig";

describe("summarizeClaudeSettings", () => {
  test("absent or empty file yields no chips and no error", () => {
    expect(summarizeClaudeSettings(null)).toEqual({ chips: [], invalid: false });
    expect(summarizeClaudeSettings("  ")).toEqual({ chips: [], invalid: false });
    expect(summarizeClaudeSettings("{}")).toEqual({ chips: [], invalid: false });
  });

  test("malformed JSON is flagged, not thrown", () => {
    expect(summarizeClaudeSettings("{oops")).toEqual({ chips: [], invalid: true });
    expect(summarizeClaudeSettings("[1,2]")).toEqual({ chips: [], invalid: true });
  });

  test("surfaces the known keys as chips", () => {
    const raw = JSON.stringify({
      model: "opus",
      outputStyle: "explanatory",
      permissions: { defaultMode: "acceptEdits", allow: ["Bash(bun:*)"], deny: [] },
      env: { A: "1", B: "2" },
      hooks: { PostToolUse: [], Stop: [] },
      enabledPlugins: { "repo@market": ["x"] },
      statusLine: { type: "command" },
    });
    const { chips, invalid } = summarizeClaudeSettings(raw);
    expect(invalid).toBe(false);
    expect(chips).toEqual([
      { label: "model", value: "opus" },
      { label: "output style", value: "explanatory" },
      { label: "permissions", value: "acceptEdits" },
      { label: "allow rules", value: "1" },
      { label: "env", value: "2" },
      { label: "hooks", value: "PostToolUse, Stop" },
      { label: "plugins", value: "1" },
      { label: "status line" },
    ]);
  });

  test("ignores unknown keys and wrong-typed known keys", () => {
    const raw = JSON.stringify({ model: 3, somethingElse: true, permissions: "nope" });
    expect(summarizeClaudeSettings(raw).chips).toEqual([]);
  });
});

describe("listMcpServers", () => {
  test("null or malformed input yields no rows", () => {
    expect(listMcpServers(null)).toEqual([]);
    expect(listMcpServers("{broken")).toEqual([]);
    expect(listMcpServers('"just a string"')).toEqual([]);
  });

  test("maps url and command transports to one-line details", () => {
    const raw = JSON.stringify({
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
      local: { command: "npx", args: ["-y", "some-mcp"] },
      weird: 42,
    });
    expect(listMcpServers(raw)).toEqual([
      { name: "linear", detail: "https://mcp.linear.app/mcp" },
      { name: "local", detail: "npx -y some-mcp" },
      { name: "weird", detail: "—" },
    ]);
  });
});
