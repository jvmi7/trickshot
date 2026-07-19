import { describe, expect, test } from "bun:test";
import { profileAccent, profileBg, profileFor, TERM_PROFILES } from "./termProfiles";

describe("terminal profiles", () => {
  test("every profile is complete and well-formed", () => {
    const HEX = /^#[0-9a-f]{6}$/i;
    for (const p of TERM_PROFILES) {
      expect(p.ansi).toHaveLength(16);
      for (const c of p.ansi) expect(c).toMatch(HEX);
      expect(p.bg).toMatch(HEX);
      expect(p.fg).toMatch(HEX);
      expect(p.cursor).toMatch(HEX);
      expect(p.accent).toMatch(HEX);
      expect(p.bgOpacity).toBeGreaterThan(0);
      expect(p.bgOpacity).toBeLessThanOrEqual(1);
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

  test("profileBg blends the profile bg over the app theme bg", () => {
    const path = "/repos/.app-worktrees/keen-fjord";
    const p = profileFor(path);
    const bg = profileBg(path);
    expect(bg).toContain(p.bg);
    expect(bg).toContain(`${Math.round(p.bgOpacity * 100)}%`);
    expect(bg).toContain("var(--base-bg)");
  });
});
