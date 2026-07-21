<script lang="ts">
  // ONE CLI chat cell: the real Claude Code TUI on one chat's claude-slot PTY
  // — host + backdrop/cursor-trail + attach + the per-chat "session ended"
  // bar. Rendered by ClaudeTerminalPane once per VISIBLE chat (one in tabs
  // layout, all of them in grid), so this is the grid-ready unit: adding a
  // cell is just rendering another instance. Feature component (stores +
  // session orchestration).
  import { chatStatusByKey, ensureClaudeOpen } from "../stores";
  import { cursorTrail } from "../cursorTrail";
  import { attachTerminal, claudeTermKey } from "../terminal";
  import { Button } from "$lib/components/ui/button";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";

  let { worktree, chatId }: { worktree: string; chatId: string } = $props();

  let container = $state<HTMLDivElement | null>(null);
  let error = $state("");

  const key = $derived(claudeTermKey(worktree, chatId));
  // The CLI died (/exit, crash) — the dim in-terminal note scrolls away, so
  // give the state a persistent affordance. Type-to-revive still works too.
  const stopped = $derived($chatStatusByKey[key] === "stopped");

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
    return attachTerminal(claudeTermKey(wt, id), el, {
      onOpen: () => ensureClaudeOpen(wt, id),
      onError: (e) => (error = String(e)),
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
  <!-- Backdrop: carries the bg color + the trailing cursor glow; xterm above
       is transparent (allowTransparency), so the glow shows through between
       the glyphs. -->
  <div class="term-bg" aria-hidden="true" use:cursorTrail={{ reach: true }}></div>
  <div class="term-host" bind:this={container}></div>
</div>

<style>
  /* One-component banner (split-by-reach): sits above the host, not over it. */
  .term-stopped {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
  }
</style>
