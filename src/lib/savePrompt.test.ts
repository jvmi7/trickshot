import { describe, expect, test } from "bun:test";
import { formatRebasePrompt, formatSavePrompt } from "./savePrompt";

describe("formatSavePrompt", () => {
  const base = {
    branch: "swift-harbor",
    step: "push",
    error: "! [rejected] main -> main (fetch first)",
    done: ["staged all changes", "committed"],
  };

  test("carries the branch, the failed step, the error, and what's done", () => {
    const p = formatSavePrompt(base);
    expect(p).toContain("origin/swift-harbor");
    expect(p).toContain("Failed at: push");
    expect(p).toContain("(fetch first)");
    expect(p).toContain("staged all changes, committed");
  });

  test("keeps the loss-prevention guardrails", () => {
    const p = formatSavePrompt(base);
    expect(p).toContain("Never discard");
    expect(p).toContain("No force-push");
    expect(p).toContain("stop and ask me");
  });

  test("empty done-list reads honestly", () => {
    expect(formatSavePrompt({ ...base, done: [] })).toContain("nothing yet");
  });

  test("giant git error dumps are truncated", () => {
    const p = formatSavePrompt({ ...base, error: "x".repeat(9000) });
    expect(p).toContain("[truncated]");
    expect(p.length).toBeLessThan(3500);
  });
});

describe("formatRebasePrompt", () => {
  const base = {
    branch: "auth-refactor",
    defaultBranch: "main",
    error: "CONFLICT (content): src/x.ts",
  };

  test("names both branches and carries the conflict", () => {
    const p = formatRebasePrompt(base);
    expect(p).toContain("auth-refactor");
    expect(p).toContain("origin/main");
    expect(p).toContain("CONFLICT (content)");
  });

  test("keeps the safety rails: no discard, lease-only force, clean abort", () => {
    const p = formatRebasePrompt(base);
    expect(p).toContain("never discard");
    expect(p).toContain("--force-with-lease");
    expect(p).toContain("abort the rebase");
  });

  test("truncates giant conflict dumps", () => {
    expect(formatRebasePrompt({ ...base, error: "y".repeat(9000) })).toContain("[truncated]");
  });
});
