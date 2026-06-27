// Cross-process conformance gates — the machine-checks for the invariants that
// have NO compiler link across the three processes (CLAUDE.md → SYNC RULE). The
// two TS protocol ends are already compiler-locked (shared/protocol.ts imported
// by both, plus the `never` exhaustiveness guards in core.ts + agentEvents.ts);
// what's left is hand-mirrored and silent on drift:
//
//   1. wire `kind`s (shared/protocol.ts)        ↔ ARCHITECTURE.md protocol tables
//   2. Rust command registry (lib.rs)           ↔ api.ts invoke() ↔ ARCHITECTURE.md
//   3. Rust AgentEvent struct (agent.rs)        ↔ TS AgentEnvelope (types.ts)
//   4. default theme palette (themes.ts)        ↔ app.css :root static fallback
//   5. selectable fonts (stores.ts FONTS)       ↔ app.css [data-font] blocks
//   6. "api.ts is the sole IPC hook" rule       ↔ no raw invoke()/listen() in .svelte
//
// These read source/docs as text and assert the seams line up, so a one-sided
// edit fails `bun test` instead of breaking silently in production. Run by
// `bun test` (the frontend CI job); excluded from the tsconfigs like every
// *.test.ts. Direction note: the code→docs checks are strict (every code symbol
// MUST be documented); the docs→code reverse is intentionally NOT parsed from the
// prose tables (brittle), EXCEPT for commands, where lib.rs ↔ api.ts is an exact
// set-equality (both are robustly parseable and a mismatch is a real runtime bug).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FONTS } from "./stores";
import { PALETTE_VARS, THEMES, type ThemePalette } from "./themes";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PROTOCOL = read("shared/protocol.ts");
const ARCH = read("ARCHITECTURE.md");
const AGENT_RS = read("src-tauri/src/agent.rs");
const LIB_RS = read("src-tauri/src/lib.rs");
const API_TS = read("src/lib/api.ts");
const TYPES_TS = read("src/lib/types.ts");
const APP_CSS = read("src/app.css");

/** All distinct regex capture-group-1 matches in `src`. */
function matchAll(src: string, re: RegExp): string[] {
  return [...new Set([...src.matchAll(re)].map((m) => m[1] as string))];
}

/** The body of the first `{ … }` block following `header` (brace-balanced). */
function blockAfter(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`block header not found: ${header}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced block after: ${header}`);
}

// ---- 1. wire kinds ↔ ARCHITECTURE.md protocol tables ----
describe("protocol kinds are documented", () => {
  // Every `kind: "x"` in the Inbound/Outbound unions (the only `kind:` literals
  // in protocol.ts) must appear, backtick-quoted, in the ARCHITECTURE.md tables.
  const kinds = matchAll(PROTOCOL, /kind:\s*"([a-z_]+)"/g);

  test("protocol.ts declares a non-trivial set of kinds", () => {
    // Sanity floor so a regex that silently matches nothing can't pass the suite.
    expect(kinds.length).toBeGreaterThan(15);
  });

  test.each(kinds)("`%s` appears in ARCHITECTURE.md", (kind) => {
    expect(ARCH.includes(`\`${kind}\``)).toBe(true);
  });
});

// ---- 2. Rust commands ↔ api.ts ↔ ARCHITECTURE.md ----
describe("Rust command surface", () => {
  // The `module::command` entries inside generate_handler![ … ] in lib.rs.
  const handlerBlock = LIB_RS.slice(
    LIB_RS.indexOf("generate_handler!"),
    LIB_RS.indexOf("]", LIB_RS.indexOf("generate_handler!")),
  );
  const registered = matchAll(handlerBlock, /\w+::(\w+)/g).sort();
  // The command strings api.ts actually invokes.
  const invoked = matchAll(API_TS, /invoke<[^>]*>\(\s*"([a-z_]+)"/g).sort();

  test("lib.rs registers a non-trivial set of commands", () => {
    expect(registered.length).toBeGreaterThan(10);
  });

  test("every registered command is invoked from api.ts (and vice versa)", () => {
    // Exact set-equality: a command registered but never wrapped (or wrapped but
    // never registered — uncallable at runtime) fails here.
    expect(invoked).toEqual(registered);
  });

  test.each(registered)("`%s` is documented in ARCHITECTURE.md", (cmd) => {
    expect(ARCH.includes(`\`${cmd}\``)).toBe(true);
  });
});

// ---- 3. Rust AgentEvent ↔ TS AgentEnvelope ----
describe("AgentEvent ↔ AgentEnvelope envelope", () => {
  const rustFields = matchAll(blockAfter(AGENT_RS, "struct AgentEvent"), /^\s*(\w+):/gm).sort();
  const tsEnvelope = blockAfter(TYPES_TS, "interface AgentEnvelope");
  const tsFields = matchAll(tsEnvelope, /^\s*(\w+):/gm).sort();

  test("struct field names match the TS interface", () => {
    expect(tsFields).toEqual(rustFields);
    expect(rustFields).toEqual(["data", "kind", "worktree"]);
  });

  test("each TS envelope kind value is emitted by agent.rs", () => {
    // The `kind: "stdout" | "stderr" | … ` union in AgentEnvelope.
    const kindUnion = tsEnvelope.match(/kind:\s*([^;]+);/)?.[1] ?? "";
    const kinds = matchAll(kindUnion, /"(\w+)"/g);
    expect(kinds.length).toBe(4);
    for (const k of kinds) expect(AGENT_RS.includes(`"${k}"`)).toBe(true);
  });
});

// ---- 4. default theme palette ↔ app.css :root fallback ----
describe("app.css :root mirrors the default theme (THEMES[0])", () => {
  // app.css holds --base-* only in the static :root fallback (themesToCss injects
  // the per-theme blocks at runtime, not into app.css). Collect them all.
  const cssVars = new Map(
    [...APP_CSS.matchAll(/(--base-[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
  const palette = THEMES[0]?.palette as ThemePalette;
  const keys = Object.keys(PALETTE_VARS) as (keyof ThemePalette)[];

  test.each(keys)("--base for `%s` matches THEMES[0]", (key) => {
    expect(cssVars.get(PALETTE_VARS[key])).toBe(palette[key]);
  });
});

// ---- 5. FONTS ↔ app.css [data-font] blocks ----
describe("selectable fonts have a [data-font] block (and vice versa)", () => {
  const blocks = matchAll(APP_CSS, /\[data-font="([\w-]+)"\]/g).sort();
  // "sans-code" is the :root default (no block by design — see stores.ts FONTS).
  const expected = FONTS.map((f) => f.id)
    .filter((id) => id !== "sans-code")
    .sort();

  test("the [data-font] selectors exactly match the non-default FONTS", () => {
    expect(blocks).toEqual(expected);
  });
});

// ---- 6. api.ts is the sole IPC hook (no raw invoke/listen in components) ----
describe("no raw Tauri IPC in .svelte files", () => {
  function svelteFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...svelteFiles(p));
      else if (e.name.endsWith(".svelte")) out.push(p);
    }
    return out;
  }
  const files = svelteFiles(join(ROOT, "src"));

  test("there are .svelte files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(
    files.map((f) => f.slice(ROOT.length + 1)),
  )("%s imports neither @tauri-apps/api/core nor /event", (rel) => {
    const src = read(rel);
    expect(/from\s+["']@tauri-apps\/api\/(core|event)["']/.test(src)).toBe(false);
  });
});
