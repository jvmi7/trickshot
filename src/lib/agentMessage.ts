// Presentation helpers for the neutral AgentMessage schema. Currently just the
// tool label/detail mapping the loading footer (App.svelte) shows for a
// `tool_call`. Provider-neutral: unknown tool names fall back to a generic
// label, so a non-Claude provider's tools render sensibly without changes.

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
export function toolDetail(name: string, input?: unknown): string {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  switch (name) {
    case "Bash":
      return trunc(i.command);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return basename(i.file_path);
    case "NotebookEdit":
      return basename(i.notebook_path);
    case "Glob":
    case "Grep":
      return trunc(i.pattern);
    case "Task":
      return trunc(i.description);
    case "WebFetch":
      return trunc(i.url);
    case "WebSearch":
      return trunc(i.query);
    default:
      return "";
  }
}
