import { describe, expect, test } from "bun:test";
import { profileAccent, profileFor, TERM_PROFILES } from "./termProfiles";

describe("terminal profiles", () => {
  test("every profile is complete and well-formed", () => {
    const HEX = /^#[0-9a-f]{6}$/i;
    for (const p of TERM_PROFILES) {
      expect(p.ansi).toHaveLength(16);
      for (const c of p.ansi) expect(c).toMatch(HEX);
      expect(p.accent).toMatch(HEX);
    }
    // ids + accents stay distinct — the accents ARE the identity signal.
    expect(new Set(TERM_PROFILES.map((p) => p.id)).size).toBe(TERM_PROFILES.length);
    expect(new Set(TERM_PROFILES.map((p) => p.accent)).size).toBe(TERM_PROFILES.length);
  });

  test("assignment is stable per path", () => {
    const path = "/repos/.app-worktrees/swift-harbor";
    expect(profileFor(path).id).toBe(profileFor(path).id);
    expect(profileAccent(path)).toBe(profileFor(path).accent);
  });
});
