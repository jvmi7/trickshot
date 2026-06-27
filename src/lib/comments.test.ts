import { describe, expect, test } from "bun:test";
import { buildCommentPrompt, type CommentMessage } from "./comments";

describe("buildCommentPrompt", () => {
  test("first turn (empty thread) includes context, selection, and the question — no thread section", () => {
    const prompt = buildCommentPrompt({
      chatContext: "User: refactor this\nAssistant: done, extracted a helper",
      selectedText: "extracted a helper",
      priorMessages: [],
      newQuestion: "why a helper and not inline?",
    });
    expect(prompt).toContain("read-only context");
    expect(prompt).toContain("refactor this");
    expect(prompt).toContain("extracted a helper");
    expect(prompt).toContain("why a helper and not inline?");
    // No prior-thread section on the first turn.
    expect(prompt).not.toContain("This comment thread so far");
  });

  test("follow-up turn replays prior thread Q&A before the new question", () => {
    const priorMessages: CommentMessage[] = [
      { role: "user", text: "why a helper?" },
      { role: "assistant", text: "it is reused in two places" },
    ];
    const prompt = buildCommentPrompt({
      chatContext: "Assistant: done",
      selectedText: "a helper",
      priorMessages,
      newQuestion: "expand on your last point",
    });
    expect(prompt).toContain("This comment thread so far");
    expect(prompt).toContain("User: why a helper?");
    expect(prompt).toContain("Assistant: it is reused in two places");
    expect(prompt).toContain("expand on your last point");
    // The prior thread must come before the new question.
    expect(prompt.indexOf("reused in two places")).toBeLessThan(
      prompt.indexOf("expand on your last point"),
    );
  });

  test("falls back gracefully when there is no surrounding conversation", () => {
    const prompt = buildCommentPrompt({
      chatContext: "",
      selectedText: "foo",
      priorMessages: [],
      newQuestion: "what is this?",
    });
    expect(prompt).toContain("(no surrounding conversation available)");
  });

  test("clamps a very long selection", () => {
    const long = "x".repeat(10_000);
    const prompt = buildCommentPrompt({
      chatContext: "",
      selectedText: long,
      priorMessages: [],
      newQuestion: "?",
    });
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(long.length);
  });
});
