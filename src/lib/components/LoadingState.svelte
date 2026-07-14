<!-- DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
     (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
     "Deprecated GUI surface" before extending. -->
<script lang="ts">
  import { activeActivity, activeSummary, selectedWorktree, sessionStatus } from "../stores";
  import { humanTime } from "../agentMessage";
  import ThinkingIndicator from "./ThinkingIndicator.svelte";

  const status = $derived($selectedWorktree ? $sessionStatus[$selectedWorktree] : undefined);
  const working = $derived(status === "busy");

  const phrase = $derived(
    $activeActivity
      ? $activeActivity.label + ($activeActivity.detail ? ` ${$activeActivity.detail}` : "")
      : "",
  );
</script>

{#if working && $activeActivity}
  <ThinkingIndicator label={phrase} startedAt={$activeActivity.startedAt} steps={$activeActivity.steps} />
{:else if $activeSummary}
  <!-- Idle: the last turn's summary stays here until the next turn starts. -->
  <div class="loading-state">
    <span class="loading-summary"
      >Finished in {humanTime($activeSummary.seconds)}{#if $activeSummary.steps > 0} · {$activeSummary.steps} step{$activeSummary.steps === 1 ? "" : "s"}{/if}</span
    >
  </div>
{/if}