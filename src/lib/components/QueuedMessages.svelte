<script lang="ts">
  // Queued follow-up messages, shown above the composer while the agent is busy.
  // They drain ONE per turn (see maybeDrainQueued in stores); here you can send the
  // next one immediately (interrupting the agent), remove one, or clear all. Feature
  // component (Tier B): reads the per-worktree queue store + calls its mutators.
  import {
    activeQueued,
    selectedWorktree,
    removeQueued,
    clearQueued,
    sendQueuedNow,
  } from "../stores";
  import IconButton from "./IconButton.svelte";
  import X from "@lucide/svelte/icons/x";
  import CornerDownLeft from "@lucide/svelte/icons/corner-down-left";

  const wt = $derived($selectedWorktree);
  const items = $derived($activeQueued);
</script>

{#if wt && items.length > 0}
  <!-- .chat-col (app.css): the composer's reading column (max-width + gutter). -->
  <div class="chat-col">
    <div class="queued-inner">
      <div class="queued-head">
        <span class="section-label">Queued · {items.length}</span>
        <div class="queued-actions">
          <button
            type="button"
            class="text-action"
            onclick={() => sendQueuedNow(wt)}
            title="Interrupt the agent and send the next queued message now"
          >
            <CornerDownLeft class="size-3" /> Send next now
          </button>
          <button
            type="button"
            class="text-action"
            onclick={() => clearQueued(wt)}
            title="Remove all queued messages"
          >
            Clear all
          </button>
        </div>
      </div>
      <ul class="queued-list">
        {#each items as q, i (q.id)}
          <li class="queued-item">
            <span class="queued-num">{i + 1}</span>
            <span class="queued-text" title={q.text}>{q.text}</span>
            <IconButton
              onclick={() => removeQueued(wt, q.id)}
              title="Remove"
              aria-label="Remove queued message"
            >
              <X />
            </IconButton>
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/if}

<style>
  .queued-inner {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px 8px;
    border: 1px solid var(--app-border);
    border-radius: calc(var(--radius) - 4px);
    background: var(--app-panel);
  }
  .queued-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 4px;
  }
  .queued-actions {
    display: flex;
    gap: 12px;
  }
  .queued-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .queued-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 1px 4px;
    border-radius: var(--radius-xs);
  }
  .queued-num {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  .queued-text {
    flex: 1;
    min-width: 0;
    font-size: var(--text-md);
    color: var(--app-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
