import { describe, expect, test } from "bun:test";
import { pairChanges, splitCommon, worthHighlighting } from "./diffIntraline";

describe("pairChanges", () => {
  test("pairs an equal del/add run positionally, both directions", () => {
    const kinds = ["ctx", "del", "del", "add", "add", "ctx"];
    const p = pairChanges(kinds);
    expect(p.get(1)).toBe(3);
    expect(p.get(2)).toBe(4);
    expect(p.get(3)).toBe(1);
    expect(p.get(4)).toBe(2);
  });

  test("unbalanced runs pair nothing", () => {
    expect(pairChanges(["del", "del", "add"]).size).toBe(0);
    expect(pairChanges(["del", "add", "add"]).size).toBe(0);
  });

  test("pure adds / pure deletes pair nothing", () => {
    expect(pairChanges(["add", "add"]).size).toBe(0);
    expect(pairChanges(["del", "ctx", "add"]).size).toBe(0); // ctx breaks the run
  });

  test("multiple independent runs each pair", () => {
    const p = pairChanges(["del", "add", "ctx", "del", "add"]);
    expect(p.get(0)).toBe(1);
    expect(p.get(3)).toBe(4);
    expect(p.size).toBe(4);
  });
});

describe("splitCommon", () => {
  test("finds prefix and suffix around a changed middle", () => {
    const { pre, suf } = splitCommon("const x = 1;", "const x = 42;");
    expect(pre).toBe("const x = ".length);
    expect(suf).toBe(";".length);
  });

  test("identical edges never overlap", () => {
    // "aaa" vs "aa": prefix would eat everything; suffix must be measured
    // over the remainder only.
    const { pre, suf } = splitCommon("aaa", "aa");
    expect(pre).toBe(2);
    expect(suf).toBe(0);
  });

  test("no common edges", () => {
    expect(splitCommon("abc", "xyz")).toEqual({ pre: 0, suf: 0 });
  });
});

describe("worthHighlighting", () => {
  test("rejects pairs with nothing in common", () => {
    expect(worthHighlighting("abc", "xyz", 0, 0)).toBe(false);
  });
  test("accepts a small mid-line change", () => {
    const a = "const x = 1;";
    const b = "const x = 42;";
    const { pre, suf } = splitCommon(a, b);
    expect(worthHighlighting(a, b, pre, suf)).toBe(true);
  });
});
