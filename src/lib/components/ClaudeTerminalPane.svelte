<script lang="ts">
  // The CLI chat mode pane: the REAL Claude Code TUI on the worktree's
  // dedicated claude-slot PTY (see ARCHITECTURE.md › "CLI chat mode"),
  // rendered in place of the GUI chat while `chatModeByWorktree` is "cli".
  // Same attach machinery as TerminalPane; the PTY (re)open path resumes the
  // worktree's newest session id (session.ts › ensureClaudeOpen), which is
  // also how a relaunch with a persisted "cli" mode gets its CLI back.
  // Feature component (reads stores + session orchestration).
  import { ensureClaudeOpen, selectedWorktree } from "../stores";
  import { attachTerminal, claudeTermKey } from "../terminal";

  let container = $state<HTMLDivElement | null>(null);
  let error = $state("");

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
  <div class="term-host" bind:this={container}></div>
</div>
