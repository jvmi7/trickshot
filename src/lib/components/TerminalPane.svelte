<script lang="ts">
  // The Terminal view: attaches the selected worktree's persistent SHELL xterm
  // instance (see lib/terminal.ts — scrollback survives tab switches) to this
  // pane via the shared attachTerminal helper, and (re)opens the PTY on mount.
  // Feature component, sibling of GitPanel/RunOutput in the mainView switch.
  // ClaudeTerminalPane is its claude-slot twin (the CLI chat mode).
  import { selectedWorktree } from "../stores";
  import { attachTerminal, ensureOpen } from "../terminal";

  let container = $state<HTMLDivElement | null>(null);
  let error = $state("");

  // (Re)attach when the worktree or container changes.
  $effect(() => {
    const wt = $selectedWorktree;
    const el = container;
    if (!wt || !el) return;
    error = "";
    return attachTerminal(wt, el, {
      onOpen: () => ensureOpen(wt),
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
