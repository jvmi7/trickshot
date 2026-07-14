// DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
// (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
// "Deprecated GUI surface" before extending.
// Strict tabular-text detection for tool results (ToolActivity → TextTable).
// Deliberately modest: ONLY two unambiguous shapes are recognized — real-tab
// TSV, and `|`-piped rows with OUTER pipes on every line (the markdown-table
// shape; an optional `| --- | --- |` alignment separator as the second line is
// dropped as syntax). Both require a consistent column count ≥ 2 across at
// least 3 data lines, no ANSI escapes, and a bounded total size. Anything
// looser (space-aligned `ls -la`, `git status`, `git diff --stat`'s single
// interior pipes, prose) returns null so the raw text path renders instead —
// a false positive is worse than a miss here.

export interface DetectedTable {
  header: string[];
  rows: string[][];
}

/** Total-size cap: beyond this, render raw (parse + table DOM isn't worth it). */
const MAX_LEN = 20_000;
const MIN_DATA_ROWS = 3;

export function detectTable(text: string): DetectedTable | null {
  if (text.length > MAX_LEN || text.includes("\x1b")) return null;
  const lines = text.trim().split("\n");
  if (lines.length < 1 + MIN_DATA_ROWS) return null;
  return detectTsv(lines) ?? detectPiped(lines);
}

/** All-or-nothing consistency: every row parsed, same column count ≥ 2. */
function consistent(rows: (string[] | null)[]): string[][] | null {
  const first = rows[0];
  if (!first || first.length < 2) return null;
  const out: string[][] = [];
  for (const r of rows) {
    if (!r || r.length !== first.length) return null;
    out.push(r);
  }
  return out;
}

function shape(rows: string[][] | null): DetectedTable | null {
  if (!rows) return null;
  const [header, ...data] = rows;
  return header && data.length >= MIN_DATA_ROWS ? { header, rows: data } : null;
}

function detectTsv(lines: string[]): DetectedTable | null {
  return shape(
    consistent(lines.map((l) => (l.includes("\t") ? l.split("\t").map((c) => c.trim()) : null))),
  );
}

/** A markdown-style alignment separator cell (`---`, `:--`, `--:`, `:-:`). */
const SEPARATOR_CELL = /^:?-{2,}:?$/;

function pipedCells(line: string): string[] | null {
  const l = line.trim();
  // Outer pipes required on every row — loose "a | b" shapes (git diff --stat,
  // prose) must NOT be claimed as tables.
  if (l.length < 2 || !l.startsWith("|") || !l.endsWith("|")) return null;
  const cells = l
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
  return cells.length >= 2 ? cells : null;
}

function detectPiped(lines: string[]): DetectedTable | null {
  const all = lines.map(pipedCells);
  // Markdown tables carry an alignment separator as the second line — drop it
  // (it's syntax, not data) before the consistency check.
  const hasSeparator = all[1]?.every((c) => SEPARATOR_CELL.test(c)) ?? false;
  return shape(consistent(hasSeparator ? [...all.slice(0, 1), ...all.slice(2)] : all));
}