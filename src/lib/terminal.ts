// Integrated-terminal frontend: one persistent xterm.js instance per worktree
// (kept in a module cache so scrollback survives tab switches and worktree
// hops), plus the `term-event` router that feeds PTY output into them. The
// TerminalPane component just attaches the cached instance to its container;
// App wires `handleTermEvent` into `api.onTermEvent` (the same wiring shape as
// agentEvents/scriptEvents).

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { get } from "svelte/store";
import * as api from "./api";
import { CLI_IDLE_MS, CliActivityTracker } from "./cliActivity";
// CIRCULAR-IMPORT CONTRACT: session.ts imports claudeTermKey/getTerminal from
// here while this module imports handleCliExit/ensureClaudeOpen from
// session.ts (and busy/unread mutators from stores.ts, which re-exports
// session) — safe because every cross-module access is a CALL-time function
// invocation (all hoisted function declarations / store handles used inside
// functions), never a module-eval dereference.
import { ensureClaudeOpen, handleCliExit } from "./session";
import {
  bumpGitRefresh,
  bumpUnread,
  pushAppNotification,
  refreshUsage,
  selectedWorktree,
  setStatus,
} from "./stores";
import type { TermEnvelope } from "./types";
import { basename } from "./utils";

/** PTY slot suffix for the dedicated Claude CLI terminal (the chat pane's CLI
 *  mode). NUL can't occur in a filesystem path, so the composite key can't
 *  collide with a real worktree. Hand-mirrored by `CLAUDE_SLOT` in
 *  src-tauri/src/terminal.rs — keep the pair in sync (see ARCHITECTURE.md). */
const CLAUDE_SLOT = "\u0000claude";
/** The claude-slot PTY key for a worktree (see CLAUDE_SLOT). */
export function claudeTermKey(worktree: string): string {
  return worktree + CLAUDE_SLOT;
}
/** The real worktree path behind a PTY key (identity for shell keys). */
function keyWorktree(key: string): string {
  return key.endsWith(CLAUDE_SLOT) ? key.slice(0, -CLAUDE_SLOT.length) : key;
}

interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  /** Whether the PTY behind this xterm is alive (reset by `exit` events). */
  open: boolean;
  /** Which program the PTY runs (derived from the cache key). The claude slot
   *  skips the keystroke auto-reconnect: reopening it as a SHELL would be
   *  wrong, and handleCliExit has already returned the user to the GUI chat. */
  slot: "shell" | "claude";
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

/** Get (or lazily create) the persistent xterm instance for a PTY key (a
 *  worktree path, or its claude-slot composite — see claudeTermKey). */
export function getTerminal(key: string): TermInstance {
  let inst = instances.get(key);
  if (!inst) {
    const slot: TermInstance["slot"] = key.endsWith(CLAUDE_SLOT) ? "claude" : "shell";
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
    // RECONNECT: reopen the PTY — as the login shell for the shell slot, as the
    // Claude CLI (resuming the newest session) for the claude slot — and replay
    // this keystroke. Without this, typing into a dead terminal is silently
    // swallowed with zero feedback; under CLI-first chat it's also the natural
    // "type to revive" path after a /exit.
    term.onData((data) => {
      api.termWrite(key, data).catch(async () => {
        const i = instances.get(key);
        if (!i) return;
        try {
          if (i.slot === "claude") await ensureClaudeOpen(keyWorktree(key));
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

// ---- CLI busy/idle detection (the multi-worktree awareness layer) ----------
// Under CLI-first chat no sidecar events fire, so the sidebar dot / unread
// badges / OS notifications would all be blind. The claude PTY's OUTPUT FLOW is
// the signal instead (see cliActivity.ts): data flowing = busy; a real burst
// ending = the turn-finished side-effects agentEvents.ts runs on `turn_end`.
const cliActivity = new Map<
  string,
  { tracker: CliActivityTracker; timer: ReturnType<typeof setTimeout> | null }
>();

function noteCliActivity(key: string) {
  let entry = cliActivity.get(key);
  if (!entry) {
    entry = { tracker: new CliActivityTracker(), timer: null };
    cliActivity.set(key, entry);
  }
  const wt = keyWorktree(key);
  if (entry.tracker.onData(Date.now()) === "busy") setStatus(wt, "busy");
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const burst = entry.tracker.onIdle(Date.now());
    setStatus(wt, "ready");
    if (burst === "turn") {
      // Mirror agentEvents.ts's turn_end side-effects: budget + git state
      // moved, and a background worktree deserves attention. ("Finished" may
      // also mean "waiting on a prompt" — either way, it needs the user.)
      refreshUsage();
      bumpGitRefresh();
      if (wt !== get(selectedWorktree)) {
        bumpUnread(wt);
        void api.notify("Agent finished", basename(wt));
        pushAppNotification(wt, "Agent finished", basename(wt));
      }
    }
  }, CLI_IDLE_MS);
}

/** Stop tracking a claude PTY (exit/dispose): kill the pending idle timer so
 *  it can't overwrite the `stopped` status with a stale `ready`. */
function clearCliActivity(key: string) {
  const entry = cliActivity.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  cliActivity.delete(key);
}

/** Route one `term-event` into the cached xterm (creating it if the first
 *  output arrives before the pane ever mounted — e.g. a background exit).
 *  `key` is the PTY key (a worktree path, or its claude-slot composite). */
export function handleTermEvent(key: string, kind: TermEnvelope["kind"], data: string | null) {
  const inst = getTerminal(key);
  switch (kind) {
    case "data":
      if (data) inst.term.write(data);
      if (inst.slot === "claude") noteCliActivity(key);
      break;
    case "exit":
      inst.open = false;
      if (inst.slot === "claude") {
        clearCliActivity(key);
        // The CLI ended (/exit, crash, or our own termClose). session.ts
        // decides what that means per chat surface (CLI-first: mark stopped,
        // type-to-revive; legacy toggle: adopt the forked id + restart the
        // sidecar). Call-time import per the CIRCULAR-IMPORT CONTRACT.
        inst.term.write("\r\n\x1b[2m[claude exited — type here to restart it]\x1b[0m\r\n");
        handleCliExit(keyWorktree(key));
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

/** Kill the PTYs and drop the cached xterms (worktree removal/archive) — BOTH
 *  slots, so an archived worktree's CLI terminal can't linger. */
export function disposeTerminal(worktree: string) {
  for (const key of [worktree, claudeTermKey(worktree)]) {
    clearCliActivity(key);
    api.termClose(key).catch(() => {});
    const inst = instances.get(key);
    if (inst) {
      inst.term.dispose();
      instances.delete(key);
    }
  }
}

/** Attach a cached xterm to a pane element and keep it fitted — the ONE
 *  attach/fit implementation shared by TerminalPane and ClaudeTerminalPane.
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
