import { describe, expect, test } from "bun:test";
import { formatReviewPrompt, type ReviewComment } from "./review";

const c = (over: Partial<ReviewComment>): ReviewComment => ({
  id: 1,
  file: "src/a.ts",
  line: "+const x = 1;",
  hunk: "@@ -1,3 +1,4 @@",
  text: "rename x",
  ...over,
});

describe("formatReviewPrompt", () => {
  test("numbers comments and anchors each to file/hunk/line", () => {
    const p = formatReviewPrompt([
      c({ id: 1 }),
      c({ id: 2, file: "src/b.ts", text: "guard null" }),
    ]);
    expect(p).toContain("1. `src/a.ts`");
    expect(p).toContain("2. `src/b.ts`");
    expect(p).toContain("Hunk: `@@ -1,3 +1,4 @@`");
    expect(p).toContain("Line: `+const x = 1;`");
    expect(p).toContain("rename x");
    expect(p).toContain("guard null");
    expect(p).toContain("these review comments");
  });

  test("a single comment uses singular copy and omits a missing hunk", () => {
    const p = formatReviewPrompt([c({ hunk: null })]);
    expect(p).toContain("this review comment");
    expect(p).not.toContain("Hunk:");
  });
});
