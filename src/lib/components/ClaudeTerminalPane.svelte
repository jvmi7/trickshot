<script lang="ts">
  // The CLI chat mode pane: the REAL Claude Code TUI on the worktree's
  // dedicated claude-slot PTY (see ARCHITECTURE.md › "CLI chat mode"),
  // rendered in place of the GUI chat while `chatModeByWorktree` is "cli".
  // Same attach machinery as TerminalPane; the PTY (re)open path resumes the
  // worktree's newest session id (session.ts › ensureClaudeOpen), which is
  // also how a relaunch with a persisted "cli" mode gets its CLI back.
  // Feature component (reads stores + session orchestration).
  import { ensureClaudeOpen, selectedWorktree, sessionStatus } from "../stores";
  import { attachTerminal, claudeTermKey } from "../terminal";
  import { Button } from "$lib/components/ui/button";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";

  let container = $state<HTMLDivElement | null>(null);
  let error = $state("");

  // The CLI died (/exit, crash) — the dim in-terminal note scrolls away, so
  // give the state a persistent affordance. Type-to-revive still works too.
  const stopped = $derived(!!$selectedWorktree && $sessionStatus[$selectedWorktree] === "stopped");

  function restart() {
    const wt = $selectedWorktree;
    if (!wt) return;
    error = "";
    ensureClaudeOpen(wt).catch((e) => (error = String(e)));
  }

  $effect(() => {
    const wt = $selectedWorktree;
    const el = container;
    if (!wt || !el) return;
    error = "";
    return attachTerminal(claudeTermKey(wt), el, {
      onOpen: () => ensureClaudeOpen(wt),
      onError: (e) => (error = String(e)),
    });
  });
</script>

<div class="term-pane">
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
  <div class="term-host term-host-claude" bind:this={container}></div>
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
