<script lang="ts">
  // The Terminal view: attaches the selected worktree's persistent SHELL xterm
  // instance (see lib/terminal.ts — scrollback survives tab switches) to this
  // pane via the shared attachTerminal helper, and (re)opens the PTY on mount.
  // Feature component; lives in the header SHELL POPOVER (ViewToggle) — the
  // PTY + scrollback persist across open/close via the instance cache.
  // ClaudeTerminalPane is its claude-slot twin (the CLI chat mode).
  import { selectedWorktree } from "../stores";
  import { attachTerminal, ensureOpen, focusTerminal } from "../terminal";

  // autofocus: false while the popover is only hover-revealed — the chat pane
  // keeps the keyboard; flipping true (click-to-pin) focuses the shell.
  let { autofocus = true }: { autofocus?: boolean } = $props();

  let container = $state<HTMLDivElement | null>(null);
  let error = $state("");

  // (Re)attach when the worktree or container changes. Focus is owned by the
  // autofocus effect below — attach itself never steals it.
  $effect(() => {
    const wt = $selectedWorktree;
    const el = container;
    if (!wt || !el) return;
    error = "";
    return attachTerminal(wt, el, {
      onOpen: () => ensureOpen(wt),
      onError: (e) => (error = String(e)),
      focus: false,
    });
  });

  // Focus on intent: mount-with-autofocus (click-opened) or a later pin flip.
  $effect(() => {
    const wt = $selectedWorktree;
    if (autofocus && wt && container) focusTerminal(wt);
  });
</script>

<div class="term-pane term-pane-popover">
  {#if error}
    <div class="term-error error-text">{error}</div>
  {/if}
  <div class="term-host" bind:this={container}></div>
</div>
