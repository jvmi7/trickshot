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
  import { attachTerminal, claudeTermKey, getTerminal } from "../terminal";
  import ChatComposer from "./ChatComposer.svelte";
  import { Button } from "$lib/components/ui/button";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";

  let {
    worktree,
    chatId,
    showComposer = true,
  }: {
    worktree: string;
    chatId: string;
    /** Grid renders ONE composer — the focused cell's (the pane decides).
     *  Tabs layout always shows it (the one visible cell IS focused). */
    showComposer?: boolean;
  } = $props();

  let container = $state<HTMLDivElement | null>(null);
  let error = $state("");
  let composer = $state<{ focusInput: () => void } | null>(null);

  /** Click anywhere in the terminal window → the composer takes the
   *  keyboard. EXCEPT when the click ended a drag-to-select (copying
   *  transcript text) — stealing focus there would feel broken. The click
   *  itself still reaches the TUI first (mouse reporting is untouched). */
  function onTermClick() {
    if (getTerminal(claudeTermKey(worktree, chatId)).term.hasSelection()) return;
    composer?.focusInput();
  }

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
    // focus: false — the composer owns the keyboard; blockKeys makes that a
    // POLICY: a focused xterm (drag-select, Tab) swallows keystrokes and
    // bounces focus to the composer instead of typing blind into the TUI's
    // cropped input box. Mouse reporting/selection stay live.
    return attachTerminal(claudeTermKey(wt, id), el, {
      onOpen: () => ensureClaudeOpen(wt, id),
      onError: (e) => (error = String(e)),
      focus: false,
      blockKeys: () => composer?.focusInput(),
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
  <!-- A convenience click-through only (keyboard users are ALREADY in the
       composer via autofocus/Tab); the terminal keeps its own real focus
       path through xterm's textarea. -->
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="term-crop" style="--crop: {cropPx}px" onclick={onTermClick}>
    <div class="term-host term-crop-host" bind:this={container}></div>
  </div>
  <!-- The custom input for normal CLI use — injects into THIS chat. The TUI
       above stays interactive for mouse reporting; a plain click hands the
       keyboard back to the composer (onTermClick). Unfocused grid cells hide
       it (showComposer) — focusing the cell mounts it, pre-focused. -->
  {#if showComposer}
    <div class="cell-composer">
      <ChatComposer bind:this={composer} {worktree} {chatId} autofocus={composerFocus} />
    </div>
  {/if}
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
     column (the host flexes; this doesn't). The box sits --app-pane-gap from
     the card's side edges — the inset the concentric --app-composer-radius
     is derived from. The negative left margin subtracts the pane's fixed
     14px terminal gutter down to that same gap. */
  .cell-composer {
    flex: none;
    padding: 8px var(--app-pane-gap) 0 0;
    margin-left: calc(var(--app-pane-gap) - 14px);
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
