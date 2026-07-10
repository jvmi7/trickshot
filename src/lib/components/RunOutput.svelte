<script lang="ts">
  // The Run view: live output of the selected worktree's script (the ViewToggle
  // "run" tab). Renders the bounded tail kept in `scriptRunByWorktree` and
  // auto-follows unless the user scrolled up. Feature component (reads stores),
  // sibling of GitPanel in the mainView switch.
  import { activeScriptRun } from "../stores";

  const run = $derived($activeScriptRun);

  let pane = $state<HTMLDivElement | null>(null);
  let follow = $state(true);

  // Auto-follow: stick to the bottom on new output while `follow` holds; any
  // manual scroll away from the bottom releases it, scrolling back re-arms it.
  $effect(() => {
    void run?.output.length;
    if (pane && follow) pane.scrollTop = pane.scrollHeight;
  });
  function onScroll() {
    if (!pane) return;
    follow = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
  }
</script>

<div class="run-pane">
  {#if !run}
    <div class="run-empty empty-state">No script has been run for this workspace.</div>
  {:else}
    <div class="run-head">
      <span class="run-name">{run.name}</span>
      {#if run.status === "running"}
        <span class="run-status running">running</span>
      {:else}
        <span class="run-status" class:failed={run.code !== null && run.code !== 0}>
          exited{run.code === null ? "" : ` (${run.code})`}
        </span>
      {/if}
    </div>
    <div class="run-body" bind:this={pane} onscroll={onScroll}>
      <pre class="run-log">{run.output.join("\n")}</pre>
    </div>
  {/if}
</div>

<style>
  .run-pane {
    /* .content is a flex ROW — claim the full pane (same as .term-pane). */
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .run-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--app-border);
    flex-shrink: 0;
  }
  .run-name {
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .run-status {
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  .run-status.running {
    color: var(--base-success);
  }
  .run-status.failed {
    color: var(--app-danger);
  }
  .run-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 12px;
  }
  .run-log {
    margin: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Text styling is the shared .empty-state (app.css); spacing stays per-site. */
  .run-empty {
    margin-top: 32px;
    padding: 0 16px;
  }
</style>
