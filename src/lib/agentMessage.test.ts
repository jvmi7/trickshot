import { describe, expect, test } from "bun:test";
import { humanTime, toolDetail, toolLabel, trunc } from "./agentMessage";

describe("toolLabel", () => {
  test("maps each known tool to its verb", () => {
    expect(toolLabel("Bash")).toBe("Running command");
    expect(toolLabel("Read")).toBe("Reading");
    expect(toolLabel("Write")).toBe("Writing file");
    expect(toolLabel("Edit")).toBe("Editing");
    expect(toolLabel("MultiEdit")).toBe("Editing");
    expect(toolLabel("NotebookEdit")).toBe("Editing notebook");
    expect(toolLabel("Glob")).toBe("Finding files");
    expect(toolLabel("Grep")).toBe("Searching");
    expect(toolLabel("Task")).toBe("Delegating");
    expect(toolLabel("WebFetch")).toBe("Fetching");
    expect(toolLabel("WebSearch")).toBe("Searching the web");
    expect(toolLabel("TodoWrite")).toBe("Updating plan");
  });

  test("default: humanizes an unknown name and strips the mcp__ prefix", () => {
    expect(toolLabel("SomethingNew")).toBe("Running SomethingNew");
    expect(toolLabel("mcp__github__create_pull_request")).toBe(
      "Running github create pull request",
    );
  });
});

describe("toolDetail", () => {
  test("picks the most relevant argument per tool", () => {
    expect(toolDetail("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(toolDetail("Read", { file_path: "/a/b/c.ts" })).toBe("c.ts");
    expect(toolDetail("Write", { file_path: "/a/b/d.ts" })).toBe("d.ts");
    expect(toolDetail("Edit", { file_path: "/x/y.ts" })).toBe("y.ts");
    expect(toolDetail("MultiEdit", { file_path: "/x/z.ts" })).toBe("z.ts");
    expect(toolDetail("NotebookEdit", { notebook_path: "/n/book.ipynb" })).toBe("book.ipynb");
    expect(toolDetail("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolDetail("Grep", { pattern: "foo.*bar" })).toBe("foo.*bar");
    expect(toolDetail("Task", { description: "do a thing" })).toBe("do a thing");
    expect(toolDetail("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(toolDetail("WebSearch", { query: "how to test" })).toBe("how to test");
  });

  test("unknown tool → no detail", () => {
    expect(toolDetail("Whatever", { anything: 1 })).toBe("");
  });

  test("missing / non-object input → safe empty (never throws)", () => {
    expect(toolDetail("Bash")).toBe("");
    expect(toolDetail("Read", undefined)).toBe("");
    expect(toolDetail("Read", "not-an-object")).toBe("");
    expect(toolDetail("Read", {})).toBe("");
  });
});

describe("trunc", () => {
  test("collapses whitespace and trims", () => {
    expect(trunc("  a   b\n c  ")).toBe("a b c");
  });

  test("clips past n with an ellipsis", () => {
    expect(trunc("abcdef", 3)).toBe("abc…");
    expect(trunc("abc", 3)).toBe("abc");
  });

  test("nullish → empty string", () => {
    expect(trunc(undefined)).toBe("");
    expect(trunc(null)).toBe("");
  });
});

describe("humanTime", () => {
  test("seconds only", () => {
    expect(humanTime(3)).toBe("3s");
    expect(humanTime(0)).toBe("0s");
  });

  test("minutes and seconds", () => {
    expect(humanTime(62)).toBe("1m 2s");
  });

  test("whole minutes drop the seconds", () => {
    expect(humanTime(120)).toBe("2m");
  });
});
