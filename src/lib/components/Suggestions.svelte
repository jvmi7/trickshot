<script lang="ts">
  // Suggested-reply chips shown above the composer when the agent is idle: pick one
  // to SEND it immediately. Data is the per-worktree `activeSuggestions` (generated
  // each turn). submitUserTurn does the optimistic bubble + IPC + clears suggestions.
  import { activeSuggestions, selectedWorktree, sessionStatus, submitUserTurn } from "../stores";
  import { Button } from "$lib/components/ui/button";

  const wt = $derived($selectedWorktree);
  const status = $derived(wt ? $sessionStatus[wt] : undefined);
  // Only a real choice point when the agent is idle — never mid-turn.
  const show = $derived(!!wt && status === "ready" && $activeSuggestions.length > 0);

  function pick(text: string) {
    if (wt) void submitUserTurn(wt, text);
  }
</script>

{#if show}
  <div class="suggestions">
    {#each $activeSuggestions as s (s)}
      <Button variant="outline" size="sm" class="rounded-full" onclick={() => pick(s)}>
        {s}
      </Button>
    {/each}
  </div>
{/if}

<style>
  /* Align with the composer's reading column (same max-width + horizontal padding). */
  .suggestions {
    width: 100%;
    max-width: var(--chat-col);
    margin-inline: auto;
    padding: 0 32px 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
