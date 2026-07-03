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
import type { TermEnvelope } from "./types";

interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  /** Whether the PTY behind this xterm is alive (reset by `exit` events). */
  open: boolean;
}

// The cache lives on globalThis, NOT at module scope: a vite HMR update clones
// this module, and a module-scoped Map would split-brain — the event router
// (imported by App before the update) writes PTY output into the OLD copy's
// instances while the pane renders the NEW copy's. Sharing one map across all
// copies makes the terminal survive hot reloads; in prod there's one module
// anyway. (Cast confined to this line: globalThis has no typed slot for it.)
const instances = ((globalThis as any).__trickshotTerms ??= new Map()) as Map<string, TermInstance>;

/** The current `--base-*` palette values, so new terminals match the theme.
 *  Exported so the pane can RE-SYNC an existing instance on attach — the value
 *  is a snapshot, and a stale one paints xterm's background a different shade
 *  than the pane behind it (a visible seam under the last row). */
export function themeColors() {
  if (typeof getComputedStyle === "undefined") return {};
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined;
  return {
    background: v("--base-bg"),
    foreground: v("--base-text"),
    cursor: v("--base-accent"),
    selectionBackground: v("--base-selection"),
  };
}

/** Get (or lazily create) the persistent xterm instance for a worktree. */
export function getTerminal(worktree: string): TermInstance {
  let inst = instances.get(worktree);
  if (!inst) {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, Menlo, monospace",
      cursorBlink: true,
      scrollback: 5000,
      theme: themeColors(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Keystrokes → PTY. If the write fails the PTY is gone (killed, or the Rust
    // core restarted under a dev rebuild — no `exit` event reaches us then), so
    // RECONNECT: reopen the PTY and replay this keystroke. Without this, typing
    // into a dead terminal is silently swallowed with zero feedback.
    term.onData((data) => {
      api.termWrite(worktree, data).catch(async () => {
        try {
          const i = instances.get(worktree);
          if (i) {
            await api.termOpen(worktree, i.term.rows, i.term.cols);
            i.open = true;
            await api.termWrite(worktree, data);
          }
        } catch {
          term.write("\r\n\x1b[2m[terminal not connected — reopen the tab]\x1b[0m\r\n");
        }
      });
    });
    inst = { term, fit, open: false };
    instances.set(worktree, inst);
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
 *  output arrives before the pane ever mounted — e.g. a background exit). */
export function handleTermEvent(worktree: string, kind: TermEnvelope["kind"], data: string | null) {
  const inst = getTerminal(worktree);
  switch (kind) {
    case "data":
      if (data) inst.term.write(data);
      break;
    case "exit":
      inst.open = false;
      inst.term.write("\r\n\x1b[2m[session ended — reopen the tab to restart]\x1b[0m\r\n");
      break;
    default: {
      // Exhaustiveness guard (SYNC RULE): a new TermEnvelope kind is a compile error.
      const _exhaustive: never = kind;
      void _exhaustive;
    }
  }
}

/** Kill the PTY and drop the cached xterm (worktree removal/archive). */
export function disposeTerminal(worktree: string) {
  api.termClose(worktree).catch(() => {});
  const inst = instances.get(worktree);
  if (inst) {
    inst.term.dispose();
    instances.delete(worktree);
  }
}
