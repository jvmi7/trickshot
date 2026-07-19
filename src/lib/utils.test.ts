import { describe, expect, test } from "bun:test";
import { basename, relativeTime, workspaceHue } from "./utils";

describe("workspaceHue", () => {
  test("stable and in range", () => {
    const h1 = workspaceHue("/repos/app-worktrees/swift-harbor");
    expect(h1).toBe(workspaceHue("/repos/app-worktrees/swift-harbor"));
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThan(360);
  });
  test("different paths get different hues (sample)", () => {
    const hues = new Set(
      ["/a/one", "/a/two", "/a/three", "/b/main", "/c/keen-fjord"].map(workspaceHue),
    );
    expect(hues.size).toBeGreaterThan(3);
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  test("buckets by coarse age", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
  test("very old falls back to a short date (locale-dependent, non-empty)", () => {
    expect(relativeTime(now - 90 * 86_400_000, now).length).toBeGreaterThan(0);
    expect(relativeTime(now - 90 * 86_400_000, now)).not.toContain("ago");
  });
  test("future timestamps clamp to just now", () => {
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});

describe("basename", () => {
  test("returns the last segment of a POSIX path", () => {
    expect(basename("/a/b/c.ts")).toBe("c.ts");
    expect(basename("c.ts")).toBe("c.ts");
  });

  test("handles Windows separators", () => {
    expect(basename("C:\\x\\y\\file.txt")).toBe("file.txt");
    expect(basename("a/b\\c")).toBe("c");
  });

  test("strips trailing separators", () => {
    expect(basename("/a/b/")).toBe("b");
    expect(basename("/a/b///")).toBe("b");
    expect(basename("C:\\x\\y\\")).toBe("y");
  });

  test("falls back to the original when there is no segment", () => {
    expect(basename("")).toBe("");
    expect(basename("/")).toBe("/");
  });
});
