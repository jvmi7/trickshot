<script lang="ts">
  // ONE CLI chat cell: the real Claude Code TUI on one chat's claude-slot PTY
  // — host + backdrop/cursor-trail + attach + the per-chat "session ended"
  // bar. Rendered by ClaudeTerminalPane once per VISIBLE chat (one in tabs
  // layout, all of them in grid), so this is the grid-ready unit: adding a
  // cell is just rendering another instance. Feature component (stores +
  // session orchestration).
  import {
    chatStatusByKey,
    ensureClaudeOpen,
    focusedChatByWorktree,
    selectedWorktree,
    terminalFontSize,
  } from "../stores";
  import { attachTerminal, claudeTermKey } from "../terminal";
  import ChatComposer from "./ChatComposer.svelte";
  import { Button } from "$lib/components/ui/button";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";

  let { worktree, chatId }: { worktree: string; chatId: string } = $props();

  let container = $state<HTMLDivElement | null>(null);
  let error = $state("");

  const key = $derived(claudeTermKey(worktree, chatId));
  // The CLI died (/exit, crash) — the dim in-terminal note scrolls away, so
  // give the state a persistent affordance. Type-to-revive still works too.
  const stopped = $derived($chatStatusByKey[key] === "stopped");
  // The composer is the PRIMARY typing surface; only the focused chat of the
  // selected worktree grabs the keyboard (grid mounts several cells at once).
  const composerFocus = $derived(
    $selectedWorktree === worktree && $focusedChatByWorktree[worktree] === chatId,
  );

  // ---- Crop the TUI's OWN input box out of the window ----
  // The ChatComposer below is the input; the CLI's bottom-anchored composer
  // (3-row box + hint line) would render twice. The attach surface is made
  // CROP_ROWS taller than the visible window and clipped by the outer
  // .term-crop, so the TUI lays those rows out below the fold. Row height is
  // MEASURED from the rendered grid (a real row div's rect — fonts and DPI
  // make any computed guess imperfect), re-measured when the type size or
  // the pane geometry changes.
  const CROP_ROWS = 4;
  let cropPx = $state(0);
  $effect(() => {
    void $terminalFontSize; // a size change re-renders the grid → re-measure
    const el = container;
    if (!el) return;
    let raf = 0;
    let tries = 0;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      // The attach effect runs after this one (declaration order), so .xterm
      // appears a beat later — hook the observer lazily from the rAF loop.
      if (!ro) {
        const xt = el.querySelector<HTMLElement>(".xterm");
        if (xt) {
          ro = new ResizeObserver(() => measure());
          ro.observe(xt);
        }
      }
      const row = el.querySelector<HTMLElement>(".xterm-rows > div");
      const h = row?.getBoundingClientRect().height ?? 0;
      // Converges: cropPx moves only when the ROW HEIGHT changes (font/DPI),
      // so the observer can't feedback-loop through the refit it triggers.
      if (h > 4) cropPx = h * CROP_ROWS;
      else if (tries++ < 20) raf = requestAnimationFrame(measure); // pre-render frames lie
    };
    raf = requestAnimationFrame(measure);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  });

  function restart() {
    error = "";
    ensureClaudeOpen(worktree, chatId).catch((e) => (error = String(e)));
  }

  $effect(() => {
    const wt = worktree;
    const id = chatId;
    const el = container;
    if (!el) return;
    error = "";
    // focus: false — the composer below owns first focus; clicking the
    // terminal still focuses xterm for TUI dialogs/menus/shortcuts.
    return attachTerminal(claudeTermKey(wt, id), el, {
      onOpen: () => ensureClaudeOpen(wt, id),
      onError: (e) => (error = String(e)),
      focus: false,
    });
  });
</script>

<div class="term-pane chat-cell">
  {#if error}
    <div class="term-error error-text">{error}</div>
  {/if}
  {#if stopped}
    <div class="term-stopped">
      <span class="notice-text">Session ended.</span>
      <Button size="sm" variant="outline" class="h-7 text-xs" onclick={restart}>
        <RotateCcw class="size-3.5" /> Restart
      </Button>
    </div>
  {/if}
  <!-- No backdrop of its own: the CELL is transparent (xterm included), so
       the shared chat-trail surface behind it (App.svelte) shows through
       between the glyphs. Grid cells get their fill from .chat-grid-cell. -->
  <!-- .term-crop is the visible WINDOW; the term-host attach surface inside
       is CROP_ROWS taller, pushing the TUI's own input box below the clip
       (the host keeps its class — the resize veil selectors key off it). -->
  <div class="term-crop" style="--crop: {cropPx}px">
    <div class="term-host term-crop-host" bind:this={container}></div>
  </div>
  <!-- The custom input for normal CLI use — injects into THIS chat. The TUI
       above stays fully interactive (click it for dialogs/menus). -->
  <div class="cell-composer">
    <ChatComposer {worktree} {chatId} autofocus={composerFocus} />
  </div>
</div>

<style>
  /* One-component banner (split-by-reach): sits above the host, not over it. */
  .term-stopped {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
  }
  /* The composer bar: docked under the terminal inside the cell's flex
     column (the host flexes; this doesn't). Right inset mirrors the pane's
     left gutter so the row sits symmetric in the card. */
  .cell-composer {
    flex: none;
    padding: 8px 14px 2px 0;
  }
  /* The crop window: takes the host's old flex slot and clips the taller
     attach surface below (where the TUI renders its own input + hint). */
  .term-crop {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .term-crop-host {
    height: calc(100% + var(--crop, 0px));
  }
</style>
