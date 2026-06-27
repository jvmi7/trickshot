import { describe, expect, test } from "bun:test";
import { basename } from "./utils";

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
