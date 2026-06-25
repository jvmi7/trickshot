<script lang="ts">
  // Compact per-worktree usage chip for the composer: running cost estimate +
  // total tokens for the selected chat, with a token breakdown on hover. Renders
  // nothing until a turn has completed (no cost yet). `costUsd` is a client-side
  // estimate (per the SDK), labelled as such in the tooltip.
  import { activeCost } from "../stores";
  import * as Tooltip from "$lib/components/ui/tooltip";

  /** Compact token count: 1234 -> "1.2k", 1_200_000 -> "1.2M". */
  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }
  function fmtCost(n: number): string {
    return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
  }

  const cost = $derived($activeCost);
  const totalTokens = $derived(cost ? cost.inputTokens + cost.outputTokens : 0);
</script>

{#if cost && cost.turns > 0}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <span {...props} class="cost-chip" aria-label="Session usage">
          {fmtCost(cost.costUsd)} · {fmtTokens(totalTokens)} tok
        </span>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>
      <div class="cost-detail">
        <div><strong>Session usage</strong> ({cost.turns} turn{cost.turns === 1 ? "" : "s"})</div>
        <div>Input: {cost.inputTokens.toLocaleString()}</div>
        <div>Output: {cost.outputTokens.toLocaleString()}</div>
        <div>Cache read: {cost.cacheReadTokens.toLocaleString()}</div>
        <div>Cache write: {cost.cacheCreationTokens.toLocaleString()}</div>
        <div class="cost-note">~{fmtCost(cost.costUsd)} estimated cost</div>
      </div>
    </Tooltip.Content>
  </Tooltip.Root>
{/if}

<style>
  .cost-chip {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--app-dim);
    white-space: nowrap;
    cursor: default;
    user-select: none;
  }
  .cost-detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    line-height: 1.4;
  }
  .cost-note {
    margin-top: 4px;
    opacity: 0.7;
  }
</style>
