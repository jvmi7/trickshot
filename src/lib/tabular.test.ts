import { describe, expect, test } from "bun:test";
import { detectTable } from "./tabular";

describe("detectTable — positives", () => {
  test("TSV: header + 3 data rows, cells trimmed", () => {
    const text = "name\tsize\tkind\na.ts\t12\tfile\nb.ts\t 3 \tfile\nsrc\t-\tdir";
    expect(detectTable(text)).toEqual({
      header: ["name", "size", "kind"],
      rows: [
        ["a.ts", "12", "file"],
        ["b.ts", "3", "file"],
        ["src", "-", "dir"],
      ],
    });
  });

  test("piped markdown table with an alignment separator row", () => {
    const text = [
      "| name | size |",
      "| --- | ---: |",
      "| a.ts | 12 |",
      "| b.ts | 3 |",
      "| c.ts | 9 |",
    ].join("\n");
    expect(detectTable(text)).toEqual({
      header: ["name", "size"],
      rows: [
        ["a.ts", "12"],
        ["b.ts", "3"],
        ["c.ts", "9"],
      ],
    });
  });

  test("piped table without a separator row", () => {
    const text = ["| a | b |", "| 1 | 2 |", "| 3 | 4 |", "| 5 | 6 |"].join("\n");
    expect(detectTable(text)).toEqual({
      header: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
        ["5", "6"],
      ],
    });
  });

  test("surrounding blank lines are tolerated (trimmed)", () => {
    const text = "\n\na\tb\n1\t2\n3\t4\n5\t6\n\n";
    expect(detectTable(text)?.rows.length).toBe(3);
  });
});

describe("detectTable — negatives", () => {
  test("prose", () => {
    expect(
      detectTable("This is a sentence.\nAnd another one.\nAnd a third.\nAnd more."),
    ).toBeNull();
  });

  test("git status output", () => {
    const text = [
      "On branch main",
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      "\tmodified:   src/lib/minimal.ts",
      "",
      'no changes added to commit (use "git add")',
    ].join("\n");
    expect(detectTable(text)).toBeNull();
  });

  test("ls -la (space-aligned, no tabs or pipes)", () => {
    const text = [
      "total 24",
      "drwxr-xr-x  5 user staff  160 Jul  8 10:00 .",
      "drwxr-xr-x 12 user staff  384 Jul  8 09:00 ..",
      "-rw-r--r--  1 user staff 1204 Jul  8 10:00 a.ts",
      "-rw-r--r--  1 user staff  312 Jul  8 10:00 b.ts",
    ].join("\n");
    expect(detectTable(text)).toBeNull();
  });

  test("git diff --stat (single interior pipes, no outer pipes)", () => {
    const text = [
      " src/lib/a.ts | 12 ++++----",
      " src/lib/b.ts |  3 +",
      " src/lib/c.ts |  9 +++++",
      " 3 files changed, 14 insertions(+), 10 deletions(-)",
    ].join("\n");
    expect(detectTable(text)).toBeNull();
  });

  test("inconsistent column counts", () => {
    expect(detectTable("a\tb\n1\t2\n3\t4\t5\n6\t7")).toBeNull();
    expect(detectTable("| a | b |\n| 1 | 2 | 3 |\n| 4 | 5 |\n| 6 | 7 |")).toBeNull();
  });

  test("interior blank line disqualifies", () => {
    expect(detectTable("a\tb\n1\t2\n\n3\t4\n5\t6")).toBeNull();
  });

  test("single column is not a table", () => {
    expect(detectTable("|a|\n|1|\n|2|\n|3|")).toBeNull();
  });

  test("too few data rows", () => {
    expect(detectTable("a\tb\n1\t2\n3\t4")).toBeNull();
  });

  test("ANSI escapes disqualify", () => {
    expect(detectTable("a\tb\n\x1b[31m1\x1b[0m\t2\n3\t4\n5\t6")).toBeNull();
  });

  test("oversized input disqualifies", () => {
    const row = "aaaa\tbbbb\n";
    expect(detectTable("a\tb\n" + row.repeat(3000))).toBeNull();
  });

  test("empty input", () => {
    expect(detectTable("")).toBeNull();
  });
});
