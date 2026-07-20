import { describe, expect, test } from "bun:test";
import { generateWorktreeName } from "./branchNames";

describe("generateWorktreeName", () => {
  test("produces a kebab pair", () => {
    expect(generateWorktreeName(new Set(), () => 0)).toMatch(/^[a-z]+-[a-z]+$/);
  });

  test("avoids taken names by re-rolling", () => {
    // rand sequence: first pair collides, the re-roll lands elsewhere.
    const first = generateWorktreeName(new Set(), () => 0);
    const seq = [0, 0, 0.5, 0.5];
    let i = 0;
    const name = generateWorktreeName(new Set([first]), () => seq[i++ % seq.length] ?? 0.5);
    expect(name).not.toBe(first);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  test("falls back to numeric suffixes when everything collides", () => {
    // rand pinned to 0 → every roll is the same pair.
    const base = generateWorktreeName(new Set(), () => 0);
    const taken = new Set([base, `${base}-2`, `${base}-3`]);
    expect(generateWorktreeName(taken, () => 0)).toBe(`${base}-4`);
  });
});
