<!-- DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
     (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
     "Deprecated GUI surface" before extending. -->
<script lang="ts">
  // Suggested-reply chips shown above the composer when the agent is idle: pick one
  // to SEND it immediately. Data is the per-worktree `activeSuggestions` (generated
  // each turn). submitUserTurn does the optimistic bubble + IPC + clears suggestions.
  import {
    activeSuggestions,
    hiddenMessageCount,
    renderedGroups,
    selectedWorktree,
    sessionStatus,
    submitUserTurn,
  } from "../stores";
  import { Button } from "$lib/components/ui/button";

  // First-run fallback: a brand-new worktree has no conversation for the sidecar
  // to generate suggestions from, so seed starters that show off live tool use on
  // the user's own repo. DERIVED, never written to the suggestions store — they
  // vanish the moment the transcript has any message (first send, restored
  // history, even an error bubble) and can't race the real turn_end machinery.
  const SEED_SUGGESTIONS = ["give me a tour of this codebase", "what changed here recently?"];

  const wt = $derived($selectedWorktree);
  const status = $derived(wt ? $sessionStatus[wt] : undefined);
  const transcriptEmpty = $derived($renderedGroups.length === 0 && $hiddenMessageCount === 0);
  const chips = $derived(
    $activeSuggestions.length > 0 ? $activeSuggestions : transcriptEmpty ? SEED_SUGGESTIONS : [],
  );
  // Only a real choice point when the agent is idle — never mid-turn.
  const show = $derived(!!wt && status === "ready" && chips.length > 0);

  function pick(text: string) {
    if (wt) void submitUserTurn(wt, text);
  }
</script>

{#if show}
  <div class="suggestions chat-col">
    {#each chips as s (s)}
      <Button variant="outline" size="sm" class="rounded-full" onclick={() => pick(s)}>
        {s}
      </Button>
    {/each}
  </div>
{/if}

<style>
  /* Chip row layout; the reading-column width/gutter comes from the shared
     .chat-col (app.css), matching the composer. */
  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>