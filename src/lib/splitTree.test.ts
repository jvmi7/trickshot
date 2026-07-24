import { describe, expect, test } from "bun:test";
import {
  defaultTree,
  heal,
  isSplitNode,
  leavesOf,
  moveLeaf,
  prune,
  type SplitNode,
  splitLeaf,
  treeToGrid,
} from "./splitTree";

const leaf = (chat: string): SplitNode => ({ chat });

describe("splitLeaf", () => {
  test.each([
    ["right", "row", ["a", "n"]],
    ["left", "row", ["n", "a"]],
    ["down", "column", ["a", "n"]],
    ["up", "column", ["n", "a"]],
  ] as const)("%s → %s split, order %p", (where, dir, order) => {
    const t = splitLeaf(leaf("a"), "a", where, "n");
    expect("dir" in t && t.dir).toBe(dir);
    expect(leavesOf(t)).toEqual([...order]);
  });

  test("splits the nested target, not its siblings", () => {
    const t: SplitNode = { dir: "row", a: leaf("a"), b: leaf("b") };
    const out = splitLeaf(t, "b", "down", "n");
    expect(leavesOf(out)).toEqual(["a", "b", "n"]);
    expect("dir" in out && out.a).toBe(t.a); // untouched branch keeps identity
  });

  test("unknown target is an identity no-op", () => {
    const t: SplitNode = { dir: "row", a: leaf("a"), b: leaf("b") };
    expect(splitLeaf(t, "zz", "right", "n")).toBe(t);
  });
});

describe("prune", () => {
  const t: SplitNode = {
    dir: "row",
    a: leaf("a"),
    b: { dir: "column", a: leaf("b"), b: leaf("c") },
  };

  test("dead leaf collapses its parent to the sibling", () => {
    const out = prune(t, new Set(["a", "c"]));
    expect(out && leavesOf(out)).toEqual(["a", "c"]);
    // b's split node is GONE — c hoisted in its place
    expect(out && "dir" in out && "chat" in out.b && out.b.chat).toBe("c");
  });

  test("nothing kept → null; everything kept → same identity", () => {
    expect(prune(t, new Set())).toBeNull();
    expect(prune(t, new Set(["a", "b", "c"]))).toBe(t);
  });
});

describe("moveLeaf", () => {
  const t: SplitNode = {
    dir: "row",
    a: leaf("a"),
    b: { dir: "column", a: leaf("b"), b: leaf("c") },
  };

  test("moves the source into the target's half; the old slot collapses", () => {
    // drag a onto the TOP half of c: b|c column keeps c's slot split by a
    const out = moveLeaf(t, "a", "c", "up");
    expect(leavesOf(out)).toEqual(["b", "a", "c"]);
    // a's old row split is gone — the column is now the root
    expect("dir" in out && out.dir).toBe("column");
  });

  test("each zone lands on the right side of the target", () => {
    const two: SplitNode = { dir: "row", a: leaf("a"), b: leaf("b") };
    expect(leavesOf(moveLeaf(two, "a", "b", "left"))).toEqual(["a", "b"]);
    expect(leavesOf(moveLeaf(two, "a", "b", "right"))).toEqual(["b", "a"]);
    const moved = moveLeaf(two, "a", "b", "down");
    expect("dir" in moved && moved.dir).toBe("column");
    expect(leavesOf(moved)).toEqual(["b", "a"]);
  });

  test("self-move, missing ids, and a source-only tree are identity no-ops", () => {
    expect(moveLeaf(t, "a", "a", "up")).toBe(t);
    expect(moveLeaf(t, "zz", "a", "up")).toBe(t);
    expect(moveLeaf(t, "a", "zz", "up")).toBe(t);
    const solo: SplitNode = leaf("a");
    expect(moveLeaf(solo, "a", "b", "up")).toBe(solo);
  });
});

describe("defaultTree / heal", () => {
  test("4 ids make a 2×2 (row of two columns)", () => {
    const t = defaultTree(["a", "b", "c", "d"]);
    const g = treeToGrid(t);
    expect(g.cols.split(" ")).toHaveLength(2);
    expect(g.rows.split(" ")).toHaveLength(2);
    expect(leavesOf(t)).toEqual(["a", "b", "c", "d"]);
  });

  test("heal without a tree builds the default; empty ids → null", () => {
    expect(heal(undefined, [])).toBeNull();
    const t = heal(undefined, ["a", "b"]);
    expect(t && leavesOf(t)).toEqual(["a", "b"]);
  });

  test("heal prunes dead leaves and appends unknown ids rightward", () => {
    const t: SplitNode = { dir: "column", a: leaf("a"), b: leaf("dead") };
    const out = heal(t, ["a", "new"]);
    expect(out && leavesOf(out)).toEqual(["a", "new"]);
  });

  test("heal rejects malformed persisted shapes", () => {
    const bad = { dir: "row", a: { chat: "a" } } as unknown as SplitNode; // missing b
    expect(isSplitNode(bad)).toBe(false);
    const out = heal(bad, ["a", "b"]);
    expect(out && leavesOf(out)).toEqual(["a", "b"]); // fell back to defaultTree
  });
});

describe("treeToGrid", () => {
  test("A | (B / C): left spans both rows, right stacks", () => {
    const t: SplitNode = {
      dir: "row",
      a: leaf("a"),
      b: { dir: "column", a: leaf("b"), b: leaf("c") },
    };
    const g = treeToGrid(t);
    expect(g.cols).toBe("500fr 500fr");
    expect(g.rows).toBe("500fr 500fr");
    const area = (chat: string) => g.cells.find((c) => c.chat === chat)?.area;
    expect(area("a")).toBe("1 / 1 / 3 / 2"); // full height, col 1
    expect(area("b")).toBe("1 / 2 / 2 / 3");
    expect(area("c")).toBe("2 / 2 / 3 / 3");
  });

  test("uneven cuts produce proportional fr tracks with full coverage", () => {
    // a | b, then split b down, then split the lower-right down again:
    // x cut at 1/2 only; y cuts at 1/2 and 3/4 on the right side.
    let t: SplitNode = { dir: "row", a: leaf("a"), b: leaf("b") };
    t = splitLeaf(t, "b", "down", "c");
    t = splitLeaf(t, "c", "down", "d");
    const g = treeToGrid(t);
    expect(g.rows).toBe("500fr 250fr 250fr");
    // every cell's area lands on real track lines and 'a' spans all rows
    expect(g.cells.find((c) => c.chat === "a")?.area).toBe("1 / 1 / 4 / 2");
  });
});
