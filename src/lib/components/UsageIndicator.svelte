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

  /** Severity band for a utilization percent (chip + per-row meter colors). */
  function severityOf(p: number | null): "normal" | "warn" | "danger" {
    return p == null ? "normal" : p >= 90 ? "danger" : p >= 70 ? "warn" : "normal";
  }
  const severity = $derived(severityOf(primaryPct));

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
    <Tooltip.Content class="items-stretch p-2.5">
      <div class="usage-detail">
        <div class="section-label">Subscription usage</div>
        {#each windows as w (w.label)}
          {@const p = pct(w)}
          {#if p != null}
            <div class="usage-window" data-severity={severityOf(p)}>
              <div class="usage-row">
                <span class="usage-row-label">{w.label}</span>
                <span class="usage-row-pct">{p}%</span>
              </div>
              <div class="usage-meter" role="presentation">
                <div class="usage-meter-fill" style="width: {Math.min(p, 100)}%"></div>
              </div>
              <div class="usage-row-reset">{resetsIn(w.resets_at)}</div>
            </div>
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
    font-size: var(--text-sm); /* header-scale, in step with the view toggle */
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
    gap: 8px;
    min-width: 180px;
    font-size: var(--text-sm);
    line-height: 1.4;
  }
  .usage-window {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .usage-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .usage-row-label {
    color: var(--base-text);
  }
  .usage-row-pct {
    font-variant-numeric: tabular-nums;
    color: var(--base-text);
  }
  .usage-row-reset {
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  /* Utilization meter: a thin track filled to the window's percent, colored by
     the same severity bands as the chip. */
  .usage-meter {
    height: 3px;
    border-radius: 999px; /* pill — genuinely round */
    background: var(--app-border);
    overflow: hidden;
  }
  .usage-meter-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--base-accent);
  }
  .usage-window[data-severity="warn"] .usage-meter-fill {
    background: var(--base-warning);
  }
  .usage-window[data-severity="warn"] .usage-row-pct {
    color: var(--base-warning);
  }
  .usage-window[data-severity="danger"] .usage-meter-fill {
    background: var(--app-danger);
  }
  .usage-window[data-severity="danger"] .usage-row-pct {
    color: var(--app-danger);
  }
  .usage-note {
    color: var(--app-dim);
    font-size: var(--text-xs);
  }
</style>
