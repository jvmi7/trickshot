// Shared, framework-free helpers for reading Claude Agent SDK message internals.
// `Message.svelte` renders these content blocks; `App.svelte` uses the tool
// label/detail helpers to drive the loading footer. Keeping the parsing in ONE
// module (rather than duplicated per component) honors the "one place reads SDK
// internals" rule in CLAUDE.md — read defensively here, never throw.

import type { SDKMessageLike } from "./types";

/** The Anthropic content blocks nested under an SDK message's `message.content`,
 *  or [] for any message without an array body. Returns `any[]` on purpose: the
 *  UI branches on `b.type` and reads known block fields defensively (see the
 *  PERFORMANCE note on `blocks()` in CLAUDE.md). */
export function contentBlocks(m: SDKMessageLike): any[] {
  const content = (m as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content) ? content : [];
}

/** Last path segment of a file-ish value (for compact tool labels). */
export const basename = (p: unknown) =>
  String(p ?? "")
    .split("/")
    .pop() || String(p ?? "");

/** Collapse whitespace and clip to `n` chars with an ellipsis. */
export function trunc(s: unknown, n = 64): string {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** Human-readable verb for a tool call, e.g. "Running command" (loading footer). */
export function toolLabel(name: string): string {
  switch (name) {
    case "Bash":
      return "Running command";
    case "Read":
      return "Reading";
    case "Write":
      return "Writing file";
    case "Edit":
    case "MultiEdit":
      return "Editing";
    case "NotebookEdit":
      return "Editing notebook";
    case "Glob":
      return "Finding files";
    case "Grep":
      return "Searching";
    case "Task":
      return "Delegating";
    case "WebFetch":
      return "Fetching";
    case "WebSearch":
      return "Searching the web";
    case "TodoWrite":
      return "Updating plan";
    default:
      return "Running " + name.replace(/^mcp__/, "").replace(/_/g, " ");
  }
}

/** The tool call's most relevant argument, truncated (loading footer detail). */
export function toolDetail(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case "Bash":
      return trunc(input.command);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return basename(input.file_path);
    case "NotebookEdit":
      return basename(input.notebook_path);
    case "Glob":
    case "Grep":
      return trunc(input.pattern);
    case "Task":
      return trunc(input.description);
    case "WebFetch":
      return trunc(input.url);
    case "WebSearch":
      return trunc(input.query);
    default:
      return "";
  }
}
