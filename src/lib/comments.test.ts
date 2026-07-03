import { describe, expect, test } from "bun:test";
import { buildCommentPrompt, type CommentMessage } from "./comments";

describe("buildCommentPrompt", () => {
  test("first turn (empty thread) includes conversation, anchored message, and the question — no thread section", () => {
    const prompt = buildCommentPrompt({
      conversation: "User: refactor this\nAssistant: done, extracted a helper",
      anchoredMessage: "done, extracted a helper",
      priorMessages: [],
      newQuestion: "why a helper and not inline?",
    });
    expect(prompt).toContain("Our conversation so far");
    expect(prompt).toContain("refactor this");
    expect(prompt).toContain("The specific message of yours I'm replying to");
    expect(prompt).toContain("done, extracted a helper");
    expect(prompt).toContain("why a helper and not inline?");
    // No prior-thread section on the first turn.
    expect(prompt).not.toContain("This thread so far");
  });

  test("follow-up turn replays prior thread Q&A before the new question", () => {
    const priorMessages: CommentMessage[] = [
      { role: "user", text: "why a helper?" },
      { role: "assistant", text: "it is reused in two places" },
    ];
    const prompt = buildCommentPrompt({
      conversation: "Assistant: done",
      anchoredMessage: "done",
      priorMessages,
      newQuestion: "expand on your last point",
    });
    expect(prompt).toContain("This thread so far");
    expect(prompt).toContain("User: why a helper?");
    expect(prompt).toContain("Assistant: it is reused in two places");
    expect(prompt).toContain("expand on your last point");
    // The prior thread must come before the new question.
    expect(prompt.indexOf("reused in two places")).toBeLessThan(
      prompt.indexOf("expand on your last point"),
    );
  });

  test("falls back gracefully when there is no earlier conversation", () => {
    const prompt = buildCommentPrompt({
      conversation: "",
      anchoredMessage: "foo",
      priorMessages: [],
      newQuestion: "what is this?",
    });
    expect(prompt).toContain("(no earlier conversation)");
  });

  test("clamps a very long anchored message", () => {
    const long = "x".repeat(10_000);
    const prompt = buildCommentPrompt({
      conversation: "",
      anchoredMessage: long,
      priorMessages: [],
      newQuestion: "?",
    });
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(long.length);
  });
});
