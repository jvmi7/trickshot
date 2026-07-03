<script lang="ts">
  // Queued follow-up messages, shown above the composer while the agent is busy.
  // They drain ONE per turn (see maybeDrainQueued in stores); here you can send the
  // next one immediately (interrupting the agent), remove one, or clear all. Feature
  // component (Tier B): reads the per-worktree queue store + calls its mutators.
  import {
    activeQueued,
    selectedWorktree,
    removeQueuedAt,
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
  <div class="queued">
    <div class="queued-inner">
      <div class="queued-head">
        <span class="queued-label">Queued · {items.length}</span>
        <div class="queued-actions">
          <button
            type="button"
            class="queued-action"
            onclick={() => sendQueuedNow(wt)}
            title="Interrupt the agent and send the next queued message now"
          >
            <CornerDownLeft class="size-3" /> Send next now
          </button>
          <button
            type="button"
            class="queued-action"
            onclick={() => clearQueued(wt)}
            title="Remove all queued messages"
          >
            Clear all
          </button>
        </div>
      </div>
      <ul class="queued-list">
        {#each items as text, i (i)}
          <li class="queued-item">
            <span class="queued-num">{i + 1}</span>
            <span class="queued-text" title={text}>{text}</span>
            <IconButton
              onclick={() => removeQueuedAt(wt, i)}
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
  /* Align with the composer's reading column (same max-width + horizontal gutter). */
  .queued {
    width: 100%;
    max-width: var(--chat-col);
    margin-inline: auto;
    padding: 0 32px;
  }
  .queued-inner {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px 8px;
    border: 1px solid var(--app-border, var(--border));
    border-radius: calc(var(--radius) - 4px);
    background: var(--app-panel, var(--muted));
  }
  .queued-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 4px;
  }
  .queued-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--app-dim, var(--muted-foreground));
  }
  .queued-actions {
    display: flex;
    gap: 12px;
  }
  .queued-action {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: transparent;
    font-size: 11px;
    font-weight: 500;
    color: var(--app-dim, var(--muted-foreground));
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .queued-action:hover {
    color: var(--app-text, var(--foreground));
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
    border-radius: 6px;
  }
  .queued-num {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-size: 11px;
    color: var(--app-dim, var(--muted-foreground));
  }
  .queued-text {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--app-text, var(--foreground));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
