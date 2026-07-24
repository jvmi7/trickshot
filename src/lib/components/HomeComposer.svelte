<script lang="ts">
  // The homepage's masked Claude input: the REAL Claude Code TUI on the
  // backing worktree's focused-chat PTY, cropped to just its composer box so
  // custom UI can wrap it. The TUI bottom-anchors its input, so the mask is a
  // bottom-aligned window over the live xterm surface — everything above (the
  // transcript, spinners, dialogs) is clipped away and a top fade absorbs the
  // partial row at the seam. Typing goes straight to the CLI (this is the
  // same cached xterm the chat pane re-parents); pressing Enter on a
  // non-empty input activates the worktree, revealing the full chat right as
  // the turn starts. Feature component (stores + session orchestration).
  import { activateWorktree, ensureClaudeOpen, focusedChatByWorktree } from "../stores";
  import { attachTerminal, claudeTermKey, getTerminal } from "../terminal";
  import { profileAccent } from "../termProfiles";
  import { basename } from "$lib/utils";
  import GitBranch from "@lucide/svelte/icons/git-branch";

  let { worktree }: { worktree: string } = $props();

  let container = $state<HTMLDivElement | null>(null);
  let error = $state("");

  // The same key the chat pane will attach: the worktree's FOCUSED chat.
  const key = $derived(claudeTermKey(worktree, $focusedChatByWorktree[worktree]));

  $effect(() => {
    const wt = worktree;
    const k = key;
    const el = container;
    if (!el) return;
    error = "";
    const detach = attachTerminal(k, el, {
      onOpen: () => ensureClaudeOpen(wt),
      onError: (e) => (error = String(e)),
    });
    // Enter on a non-empty input = the turn is submitted — jump to the full
    // chat so the response streams in the normal pane. Plain data-tap on the
    // shared xterm: "\r" is the TUI's submit; any other typed byte marks the
    // input non-empty (an Enter on an empty composer must not navigate).
    let typed = false;
    const tap = getTerminal(k).term.onData((data) => {
      if (data === "\r") {
        if (typed) void activateWorktree(wt).catch((e) => (error = String(e)));
      } else if (data.length > 0) {
        typed = true;
      }
    });
    return () => {
      tap.dispose();
      detach();
    };
  });
</script>

<div class="composer">
  <div class="composer-head">
    <span class="composer-title">Ask Claude</span>
    <span class="composer-target" title={worktree}>
      <span class="shrink-0" style="color: {profileAccent(worktree)}">
        <GitBranch class="size-3" />
      </span>
      {basename(worktree)}
    </span>
  </div>
  {#if error}
    <p class="error-text">{error}</p>
  {/if}
  <!-- The mask: a fixed-height window (overflow hidden) over a taller live
       terminal surface. The surface is a flex column justified to the END so
       the xterm grid's bottom row sits exactly on the window's bottom edge
       (the sub-row remainder gap lands at the TOP, inside the clipped area —
       never between the input box and the frame). term-pane/term-host carry
       the shared terminal chrome (transparent xterm bg, hidden scrollbars,
       the resize veil); the scoped rules below override only geometry. -->
  <div class="term-pane composer-crop">
    <div class="term-host composer-host" bind:this={container}></div>
    <div class="composer-fade" aria-hidden="true"></div>
  </div>
  <p class="composer-hint">↵ submits and opens the chat · full history lives there</p>
</div>

<style>
  /* One-component structural CSS (split-by-reach); colors from the tokens. */
  .composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: min(680px, 100%);
    margin: 0 auto;
  }
  .composer-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .composer-title {
    font-size: var(--text-md);
    font-weight: 600;
  }
  .composer-target {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  /* The visible window: ~the TUI's input box + its hint line at default type
     sizes; multiline growth extends upward into the fade. Height is a plain
     tunable — the fade makes any row remainder read as a soft edge, so it
     doesn't need cell-exact alignment. */
  .composer-crop {
    position: relative;
    display: block; /* neutralize .term-pane's flex column */
    flex: none;
    height: 128px;
    padding: 0;
    overflow: hidden;
    background: var(--base-bg);
    border: 1px solid var(--app-border);
    border-radius: var(--radius-lg);
  }
  /* The live surface: tall enough that the CLI lays out a real screen (the
     transcript region above the input is simply clipped), bottom-justified so
     the grid's last row hugs the window's bottom edge. */
  .composer-host {
    position: absolute;
    left: 10px;
    right: 4px;
    bottom: 2px;
    height: 360px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }
  /* The seam: the top of the window fades to the canvas so a clipped partial
     transcript row reads as a designed edge, not a glitch. */
  .composer-fade {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 34px;
    pointer-events: none;
    background: linear-gradient(to bottom, var(--base-bg), transparent);
    z-index: var(--app-z-overlay);
  }
  .composer-hint {
    font-size: var(--text-2xs);
    color: var(--app-dim);
    text-align: center;
  }
</style>
