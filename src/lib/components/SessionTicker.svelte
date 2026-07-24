<script lang="ts">
  // Header ticker: how many CLI sessions are WORKING right now, across every
  // worktree (busy chats — the cliActivity-derived signal, so it counts real
  // turns, not open-but-idle PTYs). Hidden at zero: the header stays quiet
  // unless agents are actually running. Feature component (reads stores).
  import { busyChatCount } from "../stores";
</script>

{#if $busyChatCount > 0}
  <span class="session-ticker" title="CLI sessions working right now">
    <span class="ticker-dot" aria-hidden="true"></span>
    {#key $busyChatCount}
      <span class="ticker-n">{$busyChatCount}</span>
    {/key}
    <span class="ticker-label">running</span>
  </span>
{/if}

<style>
  /* Header-scale chip (split-by-reach): quiet type, a breathing busy dot,
     and a digit that rolls in on every count change. */
  .session-ticker {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--app-dim);
    user-select: none;
  }
  .ticker-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--base-warning);
    /* Keyframe choreography keeps literal durations by design (a rhythm,
       not interaction feedback — see DESIGN_SYSTEM.md motion notes). */
    animation: ticker-breathe 1.6s ease-in-out infinite;
  }
  .ticker-n {
    display: inline-block;
    min-width: 1ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--app-text);
    animation: ticker-roll 220ms var(--ease-out-soft);
  }
  @keyframes ticker-breathe {
    50% {
      opacity: 0.35;
    }
  }
  @keyframes ticker-roll {
    from {
      transform: translateY(0.55em);
      opacity: 0;
    }
  }
</style>
