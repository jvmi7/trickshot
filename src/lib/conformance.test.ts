// Cross-process conformance gates — the machine-checks for the invariants that
// have NO compiler link between the webview and the Rust core (CLAUDE.md →
// SYNC RULE). These seams are hand-mirrored and silent on drift:
//
//   2. Rust command registry (lib.rs)           ↔ api.ts invoke() ↔ ARCHITECTURE.md
//   3. Rust WorktreeEvent (worktree_map.rs)     ↔ TS Script/TermEnvelope (types.ts)
//   4. default theme palette (themes.ts)        ↔ app.css :root static fallback
//   5. selectable fonts (stores.ts FONTS)       ↔ app.css [data-font] blocks
//   6. "api.ts is the sole IPC hook" rule       ↔ no raw invoke()/listen() in .svelte
//   7. design-system scales (DESIGN_SYSTEM.md)  ↔ no raw font-size/duration/z/radius/
//      color literals in styles; ui/* dark: tints stay value-relative; the dead
//      --app-* fallback idiom stays dead
//   8. ANSI classes emitted by ansi.ts          ↔ app.css .ansi-* rules + the 16
//      --app-ansi-N tokens they read
//
// (Numbering keeps the historical section ids — §1, the sidecar wire-protocol
// check, was retired with the sidecar itself.)
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
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FONTS } from "./stores";
import { PALETTE_VARS, THEMES, type ThemePalette } from "./themes";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ARCH = read("ARCHITECTURE.md");
const SCRIPTS_RS = read("src-tauri/src/scripts.rs");
const TERMINAL_RS = read("src-tauri/src/terminal.rs");
const WORKTREE_MAP_RS = read("src-tauri/src/worktree_map.rs");
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

// ---- 3. Rust WorktreeEvent ↔ TS envelopes (script / term) ----
// The per-worktree channels share ONE Rust envelope struct
// (worktree_map.rs's WorktreeEvent); each module emits it on its own channel.
// Assert (a) the shared struct's fields match every TS envelope interface,
// (b) each module actually uses the shared struct + its channel name, and
// (c) each TS envelope's `kind` union is emitted by its module.
describe("WorktreeEvent ↔ TS envelopes", () => {
  // Fields may carry a `pub`/`pub(crate)` prefix in the shared struct.
  const rustFields = matchAll(
    blockAfter(WORKTREE_MAP_RS, "struct WorktreeEvent"),
    /^\s*(?:pub(?:\(crate\))?\s+)?(\w+):/gm,
  ).sort();

  const channels: [name: string, rustSrc: string, channel: string, kindCount: number][] = [
    ["ScriptEnvelope", SCRIPTS_RS, "script-event", 4],
    ["TermEnvelope", TERMINAL_RS, "term-event", 2],
  ];

  test("the shared struct has exactly the wire fields", () => {
    expect(rustFields).toEqual(["data", "kind", "worktree"]);
  });

  describe.each(channels)("%s", (tsName, rustSrc, channel, kindCount) => {
    const tsEnvelope = blockAfter(TYPES_TS, `interface ${tsName}`);
    const tsFields = matchAll(tsEnvelope, /^\s*(\w+):/gm).sort();

    test("struct field names match the TS interface", () => {
      expect(tsFields).toEqual(rustFields);
    });

    test("the module emits the shared WorktreeEvent on its channel", () => {
      expect(rustSrc.includes("WorktreeEvent")).toBe(true);
      expect(rustSrc.includes(`"${channel}"`)).toBe(true);
    });

    test("each TS envelope kind value is emitted by the module", () => {
      // The `kind: "stdout" | "stderr" | … ` union in the TS envelope.
      const kindUnion = tsEnvelope.match(/kind:\s*([^;]+);/)?.[1] ?? "";
      const kinds = matchAll(kindUnion, /"(\w+)"/g);
      expect(kinds.length).toBe(kindCount);
      for (const k of kinds) expect(rustSrc.includes(`"${k}"`)).toBe(true);
    });
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

/** Every .svelte file under `dir`, recursively (absolute paths). */
function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...svelteFiles(p));
    else if (e.name.endsWith(".svelte")) out.push(p);
  }
  return out;
}

// ---- 6. api.ts is the sole IPC hook (no raw invoke/listen in components) ----
describe("no raw Tauri IPC in .svelte files", () => {
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

// ---- 7. design-system scale discipline (DESIGN_SYSTEM.md) ----
// The scales (--text-*, --radius-*, --app-z-*, --app-duration-*, the palette)
// only stay THE system if raw literals can't creep back in. These read the
// bespoke style surfaces (app.css + non-ui component <style>/markup) as text.
// A line ending in `/* conformance-allowlisted */` is exempt (deliberate,
// commented one-offs like Welcome's 20px wordmark).
describe("design-system scales are the only source of style literals", () => {
  const all = svelteFiles(join(ROOT, "src", "lib", "components"));
  const isUi = (f: string) => f.includes(`${join("components", "ui")}${sep}`);
  const appFiles: [rel: string, src: string][] = [
    ["src/app.css", APP_CSS],
    ...all
      .filter((f) => !isUi(f))
      .map((f): [string, string] => [f.slice(ROOT.length + 1), readFileSync(f, "utf8")]),
  ];
  const uiFiles: [rel: string, src: string][] = all
    .filter(isUi)
    .map((f): [string, string] => [f.slice(ROOT.length + 1), readFileSync(f, "utf8")]);

  /** Lines of `src` matching `re` — with comment content stripped FILE-WIDE
   *  first (a rule quoted in prose isn't an offense; block comments span lines),
   *  minus `conformance-allowlisted` lines. Blank placeholders keep line counts
   *  stable so the reported offender text is the real source line. */
  function offenders(src: string, re: RegExp): string[] {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
      .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
    const lines = src.split("\n");
    return noComments
      .split("\n")
      .map((l, i) => (re.test(l) && !lines[i]?.includes("conformance-allowlisted") ? l : ""))
      .filter(Boolean);
  }

  test("there are bespoke and ui component files to check", () => {
    expect(appFiles.length).toBeGreaterThan(10);
    expect(uiFiles.length).toBeGreaterThan(5);
  });

  test.each(appFiles)("%s: no raw font-size px (use --text-*)", (_rel, src) => {
    // px only — the markdown `em` sizes are relative-by-design. The :root base
    // size (14px) is the ONE legal px literal (the scale's anchor).
    const hits = offenders(src, /font-size:\s*[\d.]+px/).filter(
      (l) => !/font-size:\s*14px/.test(l),
    );
    expect(hits).toEqual([]);
  });

  test.each(appFiles)("%s: no literal transition durations (use --app-duration-*)", (_r, src) => {
    // Keyframe `animation:` choreography keeps literal durations by design —
    // only `transition` (interaction feedback) must ride the tokens.
    expect(offenders(src, /transition[^;{]*\b\d+(\.\d+)?m?s\b/)).toEqual([]);
  });

  test.each(appFiles)("%s: no raw z-index beyond local 0/1 (use --app-z-*)", (_r, src) => {
    expect(offenders(src, /z-index:\s*(?![01]\s*[;}])\d/)).toEqual([]);
  });

  test.each(appFiles)("%s: border-radius derives from --radius (or 999px/50%)", (_r, src) => {
    const hits = offenders(src, /border-radius:[^;{]*\d+px/).filter(
      (l) => !/var\(--radius/.test(l) && !/999px/.test(l),
    );
    expect(hits).toEqual([]);
  });

  test.each(appFiles)("%s: no color literals outside the --base-* palette", (_r, src) => {
    // Colors flow through --base-*/--app-* (THEMING.md). The only legal literals
    // are TOKEN DEFINITIONS: the :root --base-* fallback block and the
    // --app-shadow-* values (black-based by design, see the token comment).
    const hits = offenders(src, /#[0-9a-fA-F]{3,8}\b|(?:\brgb|\brgba|\bhsl|\boklch)\(/).filter(
      (l) => !/--(?:base|app-shadow)-[a-z-]+:/.test(l),
    );
    expect(hits).toEqual([]);
  });

  test.each(uiFiles)("%s: dark: utilities stay value-relative (token tints)", (_r, src) => {
    // A light-VALUED theme is just a palette swap under class="dark" — that only
    // holds while ui/* dark: variants tint TOKENS (dark:bg-input/30), never a
    // literal palette color. Guards future `shadcn-svelte add` output.
    expect(
      offenders(src, /dark:[a-z-]*(?:black|white|zinc|gray|slate|neutral|stone)|dark:[a-z-]*\[#/),
    ).toEqual([]);
  });

  test.each(appFiles)("%s: the dead --app-* fallback idiom stays dead", (_r, src) => {
    // --app-* tokens are unconditionally defined, so a var(--app-x, var(--y))
    // fallback never fires — and historically drifted into contradictions.
    expect(offenders(src, /var\(--app-[a-z0-9-]+,\s*var\(--(?!app-|base-)/)).toEqual([]);
  });
});

// ---- 8. ANSI classes (ansi.ts) ↔ app.css .ansi-* rules + --app-ansi-* tokens ----
// ansi.ts emits `.ansi-*` class names as strings; app.css owns the matching
// rules and the 16 `--app-ansi-N` tokens they read. No compiler sees a missing
// rule — a stripped class renders as unstyled text, silently — so assert the
// pairing here.
describe("ANSI classes emitted by ansi.ts have app.css rules + tokens", () => {
  const ANSI_TS = read("src/lib/ansi.ts");

  test("ansi.ts emits the fg/bg class families (guards the lists below going stale)", () => {
    expect(ANSI_TS.includes("ansi-fg-")).toBe(true);
    expect(ANSI_TS.includes("ansi-bg-")).toBe(true);
  });

  const slots = Array.from({ length: 16 }, (_, i) => i);
  test.each(slots)("--app-ansi-%i token + .ansi-fg/bg-%i rules exist in app.css", (i) => {
    expect(APP_CSS.includes(`--app-ansi-${i}:`)).toBe(true);
    expect(new RegExp(`\\.ansi-fg-${i}\\s*\\{`).test(APP_CSS)).toBe(true);
    expect(new RegExp(`\\.ansi-bg-${i}\\s*\\{`).test(APP_CSS)).toBe(true);
  });

  // The attribute classes appear as double-quoted literals in the emitter.
  const attrs = matchAll(ANSI_TS, /"(ansi-(?:bold|dim|italic|underline))"/g).sort();

  test("ansi.ts emits all 4 attribute classes", () => {
    expect(attrs).toEqual(["ansi-bold", "ansi-dim", "ansi-italic", "ansi-underline"]);
  });

  test.each(attrs)("`.%s` has an app.css rule", (cls) => {
    expect(new RegExp(`\\.${cls}\\s*\\{`).test(APP_CSS)).toBe(true);
  });
});
