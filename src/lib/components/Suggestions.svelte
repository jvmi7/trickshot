<script lang="ts">
  // Suggested-reply chips shown above the composer when the agent is idle: pick one
  // to drop it into the editable composer (so the user can tweak it before sending),
  // not auto-send. Data is the per-worktree `activeSuggestions` (generated each turn).
  import {
    activeSuggestions,
    selectedWorktree,
    sessionStatus,
    clearSuggestions,
    prefillComposer,
  } from "../stores";
  import { Button } from "$lib/components/ui/button";

  const wt = $derived($selectedWorktree);
  const status = $derived(wt ? $sessionStatus[wt] : undefined);
  // Only a real choice point when the agent is idle — never mid-turn.
  const show = $derived(!!wt && status === "ready" && $activeSuggestions.length > 0);

  function pick(text: string) {
    prefillComposer(text); // lands in the editable input; user edits / sends from there
    if (wt) clearSuggestions(wt);
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
    padding: 0 32px 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
