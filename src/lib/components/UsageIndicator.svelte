<script lang="ts">
  // Compact subscription-usage chip for the composer: how much of the rolling
  // ~5-hour window is consumed, with the weekly window + reset times on hover.
  // Data comes from `usageLimits` (the /usage endpoint via get_usage); it's a
  // best-effort, undocumented signal, so a fetch error keeps the last value and
  // surfaces in the tooltip. Renders nothing until the first successful fetch.
  import { usageLimits, usageError } from "../stores";
  import type { UsageWindow } from "$lib/types";
  import * as Tooltip from "$lib/components/ui/tooltip";

  const usage = $derived($usageLimits);
  const fiveHour = $derived(usage?.five_hour ?? null);
  const sevenDay = $derived(usage?.seven_day ?? null);

  /** Round a 0–100 utilization to a whole percent; null if absent. */
  function pct(w: UsageWindow | null): number | null {
    return w && w.utilization != null ? Math.round(w.utilization) : null;
  }
  const fivePct = $derived(pct(fiveHour));

  /** Color the chip by how close the 5h window is to the cap. */
  const severity = $derived(
    fivePct == null ? "normal" : fivePct >= 90 ? "danger" : fivePct >= 70 ? "warn" : "normal",
  );

  /** Human "resets in 2h 5m" from an ISO timestamp (coarse; refreshed per turn). */
  function resetsIn(iso: string | null | undefined): string {
    if (!iso) return "—";
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isNaN(ms)) return "—";
    if (ms <= 0) return "resetting…";
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
  }
</script>

{#if fivePct != null}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <span {...props} class="usage-chip" data-severity={severity} aria-label="Subscription usage">
          {fivePct}% used
        </span>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>
      <div class="usage-detail">
        <div><strong>Subscription usage</strong></div>
        <div>5-hour window: {fivePct}% · {resetsIn(fiveHour?.resets_at)}</div>
        {#if pct(sevenDay) != null}
          <div>Weekly: {pct(sevenDay)}% · {resetsIn(sevenDay?.resets_at)}</div>
        {/if}
        {#if $usageError}
          <div class="usage-note">Last refresh failed ({$usageError}); showing cached.</div>
        {:else}
          <div class="usage-note">Estimate from your Claude plan limits.</div>
        {/if}
      </div>
    </Tooltip.Content>
  </Tooltip.Root>
{/if}

<style>
  .usage-chip {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--app-dim);
    white-space: nowrap;
    cursor: default;
    user-select: none;
  }
  .usage-chip[data-severity="warn"] {
    color: var(--app-warning, #d97706);
  }
  .usage-chip[data-severity="danger"] {
    color: var(--destructive);
  }
  .usage-detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    line-height: 1.4;
  }
  .usage-note {
    margin-top: 4px;
    opacity: 0.7;
  }
</style>
