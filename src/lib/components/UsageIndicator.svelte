<script lang="ts">
  // Compact subscription-usage chip for the composer: how much of the most
  // immediate usage window is consumed, with every reported window + reset time
  // on hover. Provider-neutral: `usageLimits` carries labeled windows (ordered
  // most-immediate first by the probe) and this renders whatever arrives; the
  // tooltip footnote comes from the provider display registry. Best-effort
  // signal — a fetch error keeps the last value and surfaces in the tooltip.
  // Renders nothing until the first successful fetch.
  import { activeProvider, usageLimits, usageError } from "../stores";
  import { providerDisplay } from "../providers";
  import type { UsageWindow } from "$lib/types";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { badgeVariants } from "$lib/components/ui/badge";
  import { cn } from "$lib/utils";

  const windows = $derived($usageLimits?.windows ?? []);
  const primary = $derived(windows[0] ?? null);
  const usageNote = $derived(providerDisplay($activeProvider).usageNote);

  /** Round a 0–100 utilization to a whole percent; null if absent. */
  function pct(w: UsageWindow | null): number | null {
    return w && w.utilization != null ? Math.round(w.utilization) : null;
  }
  const primaryPct = $derived(pct(primary));

  // Badge recipe for the chip. `ghost` (not `outline`): the chip is borderless
  // passive text, and ghost keeps border-transparent — outline's visible border
  // would fight the design. The scoped `.usage-chip` block re-neutralizes ghost's
  // hover tint (the chip isn't a button) and owns the data-severity colors.
  const usageChipClass = cn(badgeVariants({ variant: "ghost" }), "usage-chip");

  /** Color the chip by how close the primary window is to the cap. */
  const severity = $derived(
    primaryPct == null ? "normal" : primaryPct >= 90 ? "danger" : primaryPct >= 70 ? "warn" : "normal",
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

{#if primaryPct != null}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <span {...props} class={usageChipClass} data-severity={severity} aria-label="Subscription usage">
          {primaryPct}% used
        </span>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>
      <div class="usage-detail">
        <div><strong>Subscription usage</strong></div>
        {#each windows as w (w.label)}
          {#if pct(w) != null}
            <div>{w.label}: {pct(w)}% · {resetsIn(w.resets_at)}</div>
          {/if}
        {/each}
        {#if $usageError}
          <div class="usage-note">Last refresh failed ({$usageError}); showing cached.</div>
        {:else}
          <div class="usage-note">{usageNote}</div>
        {/if}
      </div>
    </Tooltip.Content>
  </Tooltip.Root>
{/if}

<style>
  /* Pill chrome comes from badgeVariants (see usageChipClass); this block keeps
     the chip passive (no hover tint, default cursor) and colors it by severity. */
  .usage-chip {
    color: var(--app-dim);
    background: transparent;
    cursor: default;
    user-select: none;
  }
  .usage-chip[data-severity="warn"] {
    color: var(--base-warning);
  }
  .usage-chip[data-severity="danger"] {
    color: var(--app-danger);
  }
  .usage-detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--text-sm);
    line-height: 1.4;
  }
  .usage-note {
    margin-top: 4px;
    opacity: 0.7;
  }
</style>
