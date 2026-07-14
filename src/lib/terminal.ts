// Integrated-terminal frontend: one persistent xterm.js instance per worktree
// (kept in a module cache so scrollback survives tab switches and worktree
// hops), plus the `term-event` router that feeds PTY output into them. The
// TerminalPane component just attaches the cached instance to its container;
// App wires `handleTermEvent` into `api.onTermEvent` (the same wiring shape as
// agentEvents/scriptEvents).

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import * as api from "./api";
// CIRCULAR-IMPORT CONTRACT: session.ts imports agentTermKey/getTerminal from
// here while this module imports handleCliExit/ensureAgentCli/agentCliFor from
// session.ts — safe because every cross-module access is a CALL-time function
// invocation (all hoisted function declarations), never a module-eval
// dereference.
import { agentCliFor, ensureAgentCli, handleCliExit } from "./session";
import type { TermEnvelope } from "./types";

/** Separator for the dedicated agent-CLI PTY slot (the chat pane's CLI mode):
 *  key = worktree + NUL + <cli id>. NUL can't occur in a filesystem path, so
 *  the composite key can't collide with a real worktree, and the CLI id after
 *  the NUL keeps different agent CLIs' slots distinct. */
const AGENT_SLOT_SEP = "\u0000";
/** The agent-slot PTY key for a worktree's `cli` (a registry id, e.g.
 *  "claude"). Hand-mirrored by `agent_key` in src-tauri/src/terminal.rs —
 *  keep the pair in sync (see ARCHITECTURE.md). */
export function agentTermKey(worktree: string, cli: string): string {
  return worktree + AGENT_SLOT_SEP + cli;
}
/** The real worktree path behind a PTY key (identity for shell keys). */
function keyWorktree(key: string): string {
  const sep = key.indexOf(AGENT_SLOT_SEP);
  return sep === -1 ? key : key.slice(0, sep);
}
/** The agent-CLI id behind a PTY key, or null for a shell key. */
function keyCli(key: string): string | null {
  const sep = key.indexOf(AGENT_SLOT_SEP);
  return sep === -1 ? null : key.slice(sep + AGENT_SLOT_SEP.length);
}

interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  /** Whether the PTY behind this xterm is alive (reset by `exit` events). */
  open: boolean;
  /** Which program the PTY runs (derived from the cache key: an agent slot
   *  contains the NUL separator). The agent slot's keystroke auto-reconnect
   *  reopens that CLI, never a shell — reopening it as a SHELL would be wrong,
   *  and handleCliExit has already routed the exit per chat surface. */
  slot: "shell" | "agent";
}

// The cache lives on globalThis, NOT at module scope: a vite HMR update clones
// this module, and a module-scoped Map would split-brain — the event router
// (imported by App before the update) writes PTY output into the OLD copy's
// instances while the pane renders the NEW copy's. Sharing one map across all
// copies makes the terminal survive hot reloads; in prod there's one module
// anyway. (Cast confined to this line: globalThis has no typed slot for it.)
const instances = ((globalThis as any).__trickshotTerms ??= new Map()) as Map<string, TermInstance>;

/** The current theme's terminal colors, so new terminals match the theme.
 *  Exported so the pane can RE-SYNC an existing instance on attach — the value
 *  is a snapshot, and a stale one paints xterm's background a different shade
 *  than the pane behind it (a visible seam under the last row).
 *
 *  The 16 ANSI slots ride the same `--app-ansi-0..15` tokens the GUI's
 *  AnsiText renderer uses (DESIGN_SYSTEM.md), so the REAL CLI's colored
 *  output follows the active theme exactly like transcript ANSI does. xterm
 *  needs concrete colors (it paints a canvas/DOM itself, `color-mix()` isn't
 *  resolvable there) — getComputedStyle resolves the tokens to final values. */
export function themeColors() {
  if (typeof getComputedStyle === "undefined") return {};
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined;
  // The ANSI tokens are `color-mix()` expressions — xterm's own color parser
  // can't evaluate those, so resolve each to a concrete rgb() by bouncing it
  // through a probe element's computed `color` (the browser does the mixing).
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const ansi = (n: number) => {
    probe.style.color = `var(--app-ansi-${n})`;
    return getComputedStyle(probe).color || undefined;
  };
  const theme = {
    background: v("--base-bg"),
    foreground: v("--base-text"),
    cursor: v("--base-accent"),
    selectionBackground: v("--base-selection"),
    black: ansi(0),
    red: ansi(1),
    green: ansi(2),
    yellow: ansi(3),
    blue: ansi(4),
    magenta: ansi(5),
    cyan: ansi(6),
    white: ansi(7),
    brightBlack: ansi(8),
    brightRed: ansi(9),
    brightGreen: ansi(10),
    brightYellow: ansi(11),
    brightBlue: ansi(12),
    brightMagenta: ansi(13),
    brightCyan: ansi(14),
    brightWhite: ansi(15),
  };
  probe.remove();
  return theme;
}

/** The app's mono stack for terminal surfaces — one source of truth
 *  (`--app-font-mono`, see DESIGN_SYSTEM.md) with the same literal as a
 *  fallback for environments without computed styles. */
function monoFont(): string {
  if (typeof getComputedStyle === "undefined") return "ui-monospace, Menlo, monospace";
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--app-font-mono").trim() ||
    "ui-monospace, Menlo, monospace"
  );
}

/** Get (or lazily create) the persistent xterm instance for a PTY key (a
 *  worktree path, or its agent-slot composite — see agentTermKey). */
export function getTerminal(key: string): TermInstance {
  let inst = instances.get(key);
  if (!inst) {
    const slot: TermInstance["slot"] = key.includes(AGENT_SLOT_SEP) ? "agent" : "shell";
    const term = new Terminal({
      fontSize: 12,
      fontFamily: monoFont(),
      cursorBlink: true,
      scrollback: 5000,
      theme: themeColors(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Keystrokes → PTY. If the write fails the PTY is gone (killed, or the Rust
    // core restarted under a dev rebuild — no `exit` event reaches us then), so
    // RECONNECT: reopen the PTY — as the login shell for the shell slot, as the
    // key's agent CLI (resuming the newest session) for the agent slot — and replay
    // this keystroke. Without this, typing into a dead terminal is silently
    // swallowed with zero feedback; under CLI-first chat it's also the natural
    // "type to revive" path after a /exit.
    term.onData((data) => {
      api.termWrite(key, data).catch(async () => {
        const i = instances.get(key);
        if (!i) return;
        try {
          if (i.slot === "agent") {
            await ensureAgentCli(keyWorktree(key), keyCli(key) ?? undefined);
          }
          else {
            await api.termOpen(key, i.term.rows, i.term.cols);
            i.open = true;
          }
          await api.termWrite(key, data);
        } catch {
          term.write("\r\n\x1b[2m[terminal not connected — reopen the tab]\x1b[0m\r\n");
        }
      });
    });
    inst = { term, fit, open: false, slot };
    instances.set(key, inst);
  }
  return inst;
}

/** Open the PTY behind a worktree's terminal if it isn't running (idempotent
 *  on both ends — Rust no-ops while one is alive). */
export async function ensureOpen(worktree: string) {
  const inst = getTerminal(worktree);
  const { rows, cols } = inst.term;
  await api.termOpen(worktree, rows, cols);
  inst.open = true;
}

/** Route one `term-event` into the cached xterm (creating it if the first
 *  output arrives before the pane ever mounted — e.g. a background exit).
 *  `key` is the PTY key (a worktree path, or its agent-slot composite). */
export function handleTermEvent(key: string, kind: TermEnvelope["kind"], data: string | null) {
  const inst = getTerminal(key);
  switch (kind) {
    case "data":
      if (data) inst.term.write(data);
      break;
    case "exit":
      inst.open = false;
      if (inst.slot === "agent") {
        // The CLI ended (/exit, crash, or our own termClose). session.ts
        // decides what that means per chat surface (CLI-first: mark stopped,
        // type-to-revive; legacy toggle: adopt the forked id + restart the
        // sidecar). Call-time import per the CIRCULAR-IMPORT CONTRACT.
        inst.term.write("\r\n\x1b[2m[agent CLI exited — type here to restart it]\x1b[0m\r\n");
        handleCliExit(keyWorktree(key), keyCli(key) ?? undefined);
      } else {
        inst.term.write("\r\n\x1b[2m[session ended — reopen the tab to restart]\x1b[0m\r\n");
      }
      break;
    default: {
      // Exhaustiveness guard (SYNC RULE): a new TermEnvelope kind is a compile error.
      const _exhaustive: never = kind;
      void _exhaustive;
    }
  }
}

/** Kill the PTYs and drop the cached xterms (worktree removal/archive): the
 *  shell key, every cached agent-slot key, AND the persisted provider's agent
 *  key even when no xterm was ever cached for it (its PTY can outlive the
 *  cache) — so an archived worktree's CLI terminal can't linger. */
export function disposeTerminal(worktree: string) {
  const keys = new Set([worktree, agentTermKey(worktree, agentCliFor(worktree))]);
  for (const key of instances.keys()) {
    if (key.startsWith(worktree + AGENT_SLOT_SEP)) keys.add(key);
  }
  for (const key of keys) {
    api.termClose(key).catch(() => {});
    const inst = instances.get(key);
    if (inst) {
      inst.term.dispose();
      instances.delete(key);
    }
  }
}

/** Attach a cached xterm to a pane element and keep it fitted — the ONE
 *  attach/fit implementation shared by TerminalPane and AgentTerminalPane.
 *  Re-parents the persistent terminal (xterm's open() is once-per-instance),
 *  re-syncs the theme snapshot, runs the settle loop + ResizeObserver with
 *  rAF-coalesced fits, and calls `onOpen` to (re)open the PTY. Returns the
 *  cleanup for the caller's `$effect`.
 *
 *  WHY the settle loop: xterm's cell metrics are wrong until the renderer
 *  measures the real font — a fit in that window computes a badly narrow grid
 *  (a full-width pane at ~20 cols) and NOTHING re-fires later because the
 *  pane's own size never changes. For ~3s after (re)attach we keep
 *  re-proposing; only REAL dimension changes are pushed to the PTY, so once
 *  metrics settle further polls are no-ops. */
export function attachTerminal(
  key: string,
  el: HTMLElement,
  opts: { onOpen: () => Promise<void>; onError?: (e: unknown) => void },
): () => void {
  const inst = getTerminal(key);
  el.replaceChildren(); // drop a previous worktree's terminal DOM
  if (inst.term.element) el.appendChild(inst.term.element);
  else inst.term.open(el);
  // Re-sync the theme snapshot to the LIVE CSS vars so xterm's background is
  // pixel-identical to the pane behind it (also picks up theme switches).
  inst.term.options.theme = themeColors();
  inst.term.focus();

  // Fit AFTER layout settles, coalesced to one rAF per burst. Fitting
  // synchronously inside the ResizeObserver callback mutates layout and
  // re-triggers the observer, which can thrash xterm down to a tiny rows/cols
  // render (a black pane).
  let raf = 0;
  let disposed = false;
  const fitNow = () => {
    raf = 0;
    if (disposed || !el.clientHeight) return;
    // Basic garbage guard (renderer not measured at all yet).
    const dims = inst.fit.proposeDimensions();
    if (
      !dims ||
      !Number.isFinite(dims.cols) ||
      !Number.isFinite(dims.rows) ||
      dims.cols < 4 ||
      dims.rows < 2
    ) {
      return;
    }
    const before = { rows: inst.term.rows, cols: inst.term.cols };
    inst.fit.fit();
    // The DOM renderer rounds each row to device pixels, so the PAINTED grid
    // can end up a few px taller than fit's fractional math — clipping the
    // bottom row (where TUI status bars live). If the painted screen overflows
    // the host, give a row back.
    const screen = el.querySelector(".xterm-screen");
    if (screen && screen.getBoundingClientRect().height > el.clientHeight && inst.term.rows > 2) {
      inst.term.resize(inst.term.cols, inst.term.rows - 1);
    }
    const { rows, cols } = inst.term;
    if (rows !== before.rows || cols !== before.cols) {
      api.termResize(key, rows, cols).catch(() => {});
    }
  };
  const scheduleFit = () => {
    if (!raf) raf = requestAnimationFrame(fitNow);
  };
  (async () => {
    for (let i = 0; i < 15 && !disposed; i++) {
      scheduleFit();
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  opts
    .onOpen()
    .then(() => {
      // Sync the PTY to the xterm's CURRENT grid unconditionally: the PTY may
      // have just spawned with dims read BEFORE the first fit landed (the
      // 80×24 xterm default), and fitNow only pushes on a CHANGE — so without
      // this, a fit that settled while the open was in flight never reaches
      // the PTY and a TUI keeps painting a small grid inside a big pane.
      api.termResize(key, inst.term.rows, inst.term.cols).catch(() => {});
      scheduleFit();
      inst.term.focus();
    })
    .catch((e) => opts.onError?.(e));

  const ro = new ResizeObserver(scheduleFit);
  ro.observe(el);
  scheduleFit();
  return () => {
    disposed = true;
    ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
  };
}
