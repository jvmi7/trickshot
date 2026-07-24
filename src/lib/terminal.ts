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
  clearChatStatuses,
  DEFAULT_CHAT_ID,
  refreshUsage,
  selectedWorktree,
  setChatStatus,
  terminalFontSize,
} from "./stores";
import { profileAccent, profileFor } from "./termProfiles";
import type { TermEnvelope } from "./types";

/** PTY slot suffix for the dedicated Claude CLI terminals (the chat pane).
 *  NUL can't occur in a filesystem path, so the composite key can't collide
 *  with a real worktree. Hand-mirrored by `CLAUDE_SLOT` in
 *  src-tauri/src/terminal.rs — keep the pair in sync (see ARCHITECTURE.md). */
const CLAUDE_SLOT = "\u0000claude";
/** The claude-slot PTY key for one of a worktree's chats. The DEFAULT chat
 *  keeps the bare slot (pre-multi-chat sessions keep working); additional
 *  chats append `:<chat id>`. Mirrors Rust's `claude_key` — keep in sync. */
export function claudeTermKey(worktree: string, chatId?: string): string {
  return chatId && chatId !== DEFAULT_CHAT_ID
    ? `${worktree}${CLAUDE_SLOT}:${chatId}`
    : worktree + CLAUDE_SLOT;
}
/** The real worktree path behind a PTY key (identity for shell keys). */
export function keyWorktree(key: string): string {
  const i = key.indexOf(CLAUDE_SLOT);
  return i >= 0 ? key.slice(0, i) : key;
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

/** xterm ITheme slot names for ANSI 0–15, in slot order (matches the app's
 *  `--app-ansi-N` tokens — conformance §8's palette, so the TUI renders in the
 *  SAME curated colors as AnsiText instead of xterm's stock VGA set). */
const ANSI_SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** The current `--base-*` palette values, so new terminals match the theme.
 *  Exported so the pane can RE-SYNC an existing instance on attach — the value
 *  is a snapshot, and a stale one paints xterm's background a different shade
 *  than the pane behind it (a visible seam under the last row). ANSI slots are
 *  resolved through a probe element: the `--app-ansi-*` values are `var()`/
 *  `color-mix()` EXPRESSIONS, which xterm's color parser rejects — reading a
 *  probe's computed `color` yields a plain rgb() it accepts. */
export function themeColors(key?: string) {
  if (typeof getComputedStyle === "undefined") return {};
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined;
  const theme: Record<string, string | undefined> = {
    foreground: v("--base-text"),
    selectionBackground: v("--base-selection"),
  };
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolve = (expr: string) => {
    probe.style.color = expr;
    return getComputedStyle(probe).color || undefined;
  };
  if (key) {
    // Per-workspace terminal PROFILE (termProfiles.ts): its own ANSI palette,
    // with the workspace's identity accent as BOTH the main text color and the
    // cursor — the EXACT color of its sidebar chip. Background stays the APP
    // THEME's for every workspace (uniform canvas; the accent differentiates).
    const wt = keyWorktree(key);
    const p = profileFor(wt);
    theme.background = "rgba(0, 0, 0, 0)"; // transparent — the backdrop div paints it
    const accent = profileAccent(wt);
    theme.foreground = accent;
    theme.cursor = accent;
    ANSI_SLOTS.forEach((slot, i) => {
      theme[slot] = p.ansi[i];
    });
  } else {
    // No workspace context: the app theme's terminal colors.
    theme.background = "rgba(0, 0, 0, 0)"; // transparent — the backdrop div paints it
    theme.cursor = resolve("var(--base-accent)");
    ANSI_SLOTS.forEach((slot, i) => {
      const resolved = resolve(`var(--app-ansi-${i})`);
      if (resolved) theme[slot] = resolved;
    });
  }
  probe.remove();
  return theme;
}

/** Get (or lazily create) the persistent xterm instance for a PTY key (a
 *  worktree path, or its claude-slot composite — see claudeTermKey). */
export function getTerminal(key: string): TermInstance {
  let inst = instances.get(key);
  if (!inst) {
    const slot: TermInstance["slot"] = key.includes(CLAUDE_SLOT) ? "claude" : "shell";
    const term = new Terminal({
      fontSize: get(terminalFontSize),
      fontFamily: "ui-monospace, Menlo, monospace",
      cursorBlink: true,
      scrollback: 5000,
      // The PANE's backdrop div paints the background (and hosts the cursor
      // trail); xterm itself is transparent so the effect shows through.
      allowTransparency: true,
      theme: themeColors(key),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (slot === "claude") {
      // Shift+Enter → NEWLINE in the CLI. A plain terminal can't distinguish
      // Shift+Enter from Enter (both are CR), and xterm.js speaks neither the
      // kitty keyboard protocol nor CSI-u — so the TUI would submit. Send the
      // CLI's documented newline fallback ("\" + CR) ourselves and swallow
      // the keystroke.
      term.attachCustomKeyEventHandler((e) => {
        if (
          e.type === "keydown" &&
          e.key === "Enter" &&
          e.shiftKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.metaKey
        ) {
          noteCliInput(key);
          api.termWrite(key, "\\\r").catch(() => {});
          return false;
        }
        return true;
      });
    }
    // Keystrokes → PTY. If the write fails the PTY is gone (killed, or the Rust
    // core restarted under a dev rebuild — no `exit` event reaches us then), so
    // RECONNECT: reopen the PTY — as the login shell for the shell slot, as the
    // Claude CLI (resuming the newest session) for the claude slot — and replay
    // this keystroke. Without this, typing into a dead terminal is silently
    // swallowed with zero feedback; under CLI-first chat it's also the natural
    // "type to revive" path after a /exit.
    term.onData((data) => {
      // Mark the input BEFORE the PTY can echo it back — output that trails
      // user input is reactive, not a turn starting (see cliActivity.ts).
      if (slot === "claude") noteCliInput(key);
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
 *  on both ends — Rust no-ops while one is alive). When the PTY survived a
 *  webview reload (already alive, fresh empty xterm), wiggle the size so the
 *  shell/TUI repaints into the new buffer instead of showing a blank pane. */
export async function ensureOpen(worktree: string) {
  const inst = getTerminal(worktree);
  const { rows, cols } = inst.term;
  const buf = inst.term.buffer.active;
  const untouched = buf.cursorX === 0 && buf.cursorY === 0;
  const spawned = await api.termOpen(worktree, rows, cols);
  if (!spawned && untouched) {
    await api.termResize(worktree, rows, Math.max(2, cols - 1)).catch(() => {});
    await api.termResize(worktree, rows, cols).catch(() => {});
  }
  inst.open = true;
}

// ---- CLI busy/idle detection (the multi-worktree awareness layer) ----------
// The CLI emits no structured turn events, so the sidebar dot / unread badges
// key off the claude PTY's OUTPUT FLOW instead (see cliActivity.ts): data
// flowing = busy; a real burst ending = a turn finished.
const cliActivity = new Map<
  string,
  { tracker: CliActivityTracker; timer: ReturnType<typeof setTimeout> | null }
>();

function cliEntry(key: string) {
  let entry = cliActivity.get(key);
  if (!entry) {
    entry = { tracker: new CliActivityTracker(), timer: null };
    cliActivity.set(key, entry);
  }
  return entry;
}

/** User input headed for the claude PTY (keystroke, wheel, focus, an injected
 *  paste): output that follows shortly is reactive, not a turn starting. */
export function noteCliInput(key: string) {
  cliEntry(key).tracker.onInput(Date.now());
}

/** Ignore busy edges on this PTY for `ms` — bridges a known non-turn output
 *  burst (the `--resume` boot replay, the reload repaint wiggle). */
export function muteCliActivity(key: string, ms: number) {
  cliEntry(key).tracker.muteUntil(Date.now() + ms);
}

function noteCliActivity(key: string) {
  const entry = cliEntry(key);
  const wt = keyWorktree(key);
  if (entry.tracker.onData(Date.now()) === "busy") setChatStatus(wt, key, "busy");
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const burst = entry.tracker.onIdle(Date.now());
    setChatStatus(wt, key, "ready");
    if (burst === "turn") {
      // A turn just finished: budget + git state moved, and a background
      // worktree deserves attention. ("Finished" may also mean "waiting on a
      // prompt" — either way, it needs the user.)
      refreshUsage();
      bumpGitRefresh();
      if (wt !== get(selectedWorktree)) {
        bumpUnread(wt);
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
        // The CLI ended (/exit, crash, or our own termClose): session.ts marks
        // the session stopped (type-to-revive). Call-time import per the
        // CIRCULAR-IMPORT CONTRACT.
        inst.term.write("\r\n\x1b[2m[claude exited — type here to restart it]\x1b[0m\r\n");
        handleCliExit(keyWorktree(key), key);
      } else {
        // Typing revives it (the onData reconnect path) — say so.
        inst.term.write("\r\n\x1b[2m[session ended — type here to restart it]\x1b[0m\r\n");
      }
      break;
    default: {
      // Exhaustiveness guard (SYNC RULE): a new TermEnvelope kind is a compile error.
      const _exhaustive: never = kind;
      void _exhaustive;
    }
  }
}

/** Apply a font-size change to every cached terminal, refit the attached ones,
 *  and push the resulting grids to their PTYs. Called from Settings on change
 *  (this module must NOT subscribe to the store at eval — CIRCULAR-IMPORT
 *  CONTRACT); new terminals pick the size up in getTerminal. */
export function applyTerminalFontSize(px: number) {
  for (const [key, inst] of instances) {
    if (inst.term.options.fontSize === px) continue;
    const before = { rows: inst.term.rows, cols: inst.term.cols };
    inst.term.options.fontSize = px;
    if (!inst.term.element?.isConnected) continue; // detached: refits on attach
    try {
      inst.fit.fit();
    } catch {
      // renderer not measured yet — the attach settle loop will fit it
    }
    const { rows, cols } = inst.term;
    if (rows !== before.rows || cols !== before.cols) {
      api.termResize(key, rows, cols).catch(() => {});
    }
  }
}

/** Kill ONE PTY and drop its cached xterm. */
function disposeKey(key: string) {
  clearCliActivity(key);
  api.termClose(key).catch(() => {});
  const inst = instances.get(key);
  if (inst) {
    inst.term.dispose();
    instances.delete(key);
  }
}

/** Kill the PTYs and drop the cached xterms (worktree removal/archive) — the
 *  shell slot AND every chat slot, so nothing lingers. Sweeps the instance
 *  cache by key identity (a worktree can have any number of chat PTYs), plus
 *  the default chat key (its PTY may be alive with no cached xterm yet). */
export function disposeTerminal(worktree: string) {
  const keys = new Set<string>([worktree, claudeTermKey(worktree)]);
  for (const key of instances.keys()) if (keyWorktree(key) === worktree) keys.add(key);
  for (const key of keys) disposeKey(key);
  clearChatStatuses(worktree);
}

/** Kill one CHAT's PTY + xterm (closing a tab/cell). The chat's transcript in
 *  Claude Code's session store is untouched — only the process and the app-side
 *  terminal go. */
export function disposeChatTerminal(worktree: string, chatId: string) {
  disposeKey(claudeTermKey(worktree, chatId));
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
  // Start VEILED: the swapped-in terminal must not flash at full opacity for
  // the frame(s) before the observer-driven veil lands — the open path below
  // reveals (the left→right sweep) once the pane is fitted.
  el.classList.remove("term-resize-rtl");
  el.classList.add("term-resizing");
  if (inst.term.element) el.appendChild(inst.term.element);
  else inst.term.open(el);
  // Re-sync the theme snapshot to the LIVE CSS vars so xterm's background is
  // pixel-identical to the pane behind it (also picks up theme switches), and
  // the font size to the setting (a cached instance may predate a change).
  // allowTransparency FIRST: a cached instance created without it CLAMPS the
  // transparent background's alpha and keeps painting opaque black.
  inst.term.options.allowTransparency = true;
  inst.term.options.theme = themeColors(key);
  inst.term.options.fontSize = get(terminalFontSize);
  inst.term.focus();

  // Fit AFTER layout settles, coalesced to one rAF per burst. Fitting
  // synchronously inside the ResizeObserver callback mutates layout and
  // re-triggers the observer, which can thrash xterm down to a tiny rows/cols
  // render (a black pane).
  let raf = 0;
  let disposed = false;
  // The resize veil: the pane's content SITS OUT a resize burst. Showing the
  // old grid mid-tween slides the text with the pane's moving left edge (the
  // sidebar collapse), and any end-of-burst swap is a re-wrap layout jump —
  // neither can be masked in place. So the first resize event fades the
  // glyphs out (app.css › .term-resizing; the bg + trail grid stay), the
  // debounced fit lands while hidden, and the fresh TUI frame fades back in.
  const REPAINT_MS = 100; // PTY round-trip allowance before the fade-in
  let unveil: ReturnType<typeof setTimeout> | undefined;
  let lastW = el.clientWidth;
  const veil = () => {
    clearTimeout(unveil); // a new burst must not be unveiled by the last one
    unveil = undefined;
    // Sweep direction follows the pane's moving left edge: the sidebar
    // sliding IN shrinks the pane (edge travels right → reveal left→right,
    // the base mask), sliding OUT grows it (edge travels left → the mirrored
    // .term-resize-rtl mask, reveal right→left). Stamped while the pane is
    // still fully visible, where both masks paint identically — the swap
    // itself never shows.
    const w = el.clientWidth;
    if (w !== lastW) el.classList.toggle("term-resize-rtl", w > lastW);
    lastW = w;
    el.classList.add("term-resizing");
  };
  const reveal = () => {
    clearTimeout(unveil);
    unveil = setTimeout(() => el.classList.remove("term-resizing"), REPAINT_MS);
  };
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

  // Open the PTY only after the renderer has measured REAL font metrics and
  // the grid is fitted (bounded wait, ~600ms worst case). A PTY spawned at
  // xterm's 80×24 default makes the TUI paint its FIRST frame at the wrong
  // grid; the follow-up refit then reflows that frame into scattered fragments
  // — the "blank chat on launch" bug. Waiting is cheap: when the pane is
  // already measured (every re-attach after the first), the first probe
  // succeeds and this adds one microtask.
  (async () => {
    for (let i = 0; i < 12 && !disposed; i++) {
      fitNow();
      const dims = inst.fit.proposeDimensions();
      if (dims && Number.isFinite(dims.cols) && dims.cols >= 4 && dims.rows >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (disposed) return;
    opts
      .onOpen()
      .then(() => {
        // Sync the PTY to the xterm's CURRENT grid unconditionally: the PTY may
        // have spawned with dims read before a LATER fit landed, and fitNow
        // only pushes on a CHANGE — so without this, a fit that settled while
        // the open was in flight never reaches the PTY and a TUI keeps
        // painting a small grid inside a big pane.
        api.termResize(key, inst.term.rows, inst.term.cols).catch(() => {});
        scheduleFit();
        inst.term.focus();
        reveal(); // end the attach veil: sweep the (re)opened pane in
      })
      .catch((e) => {
        reveal(); // never leave the pane hidden behind a failed open
        opts.onError?.(e);
      });
  })();

  // Observer-driven fits wait for the size to SETTLE: an animated layout
  // change (the sidebar collapse/expand tweens width for --app-duration-slow)
  // streams a resize per frame, and refitting on every intermediate width
  // reflows the TUI grid dozens of times — the jagged mid-animation redraw.
  // The trailing debounce collapses the burst into ONE fit after the pane
  // stops moving, veiled for the duration (see the resize veil above);
  // direct fits (settle loop, PTY open) stay immediate and unveiled.
  let settle: ReturnType<typeof setTimeout> | undefined;
  const scheduleFitSettled = () => {
    veil();
    clearTimeout(settle);
    settle = setTimeout(() => {
      scheduleFit();
      reveal(); // REPAINT_MS comfortably covers the fit's rAF + TUI repaint
    }, 150);
  };
  const ro = new ResizeObserver(scheduleFitSettled);
  ro.observe(el);
  scheduleFit();
  return () => {
    disposed = true;
    ro.disconnect();
    clearTimeout(settle);
    clearTimeout(unveil);
    el.classList.remove("term-resizing", "term-resize-rtl");
    if (raf) cancelAnimationFrame(raf);
  };
}
