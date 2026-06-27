<script lang="ts">
  import { activeActivity, activeSummary, selectedWorktree, sessionStatus } from "../stores";
  import { humanTime } from "../agentMessage";

  // tick the elapsed timer once a second while a turn is running.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  const status = $derived($selectedWorktree ? $sessionStatus[$selectedWorktree] : undefined);
  const working = $derived(status === "busy");
  const elapsed = $derived(
    $activeActivity ? Math.max(0, Math.floor((now - $activeActivity.startedAt) / 1000)) : 0,
  );
  const time = $derived(humanTime(elapsed));

  // The "thinking" text animates two ways: a typewriter reveal (here, in JS) and a
  // shimmer sweep (CSS gradient clipped to the text — see app.css `.shimmer`). The
  // $effect re-runs whenever `phrase` changes (a new activity), retyping it.
  const phrase = $derived(
    $activeActivity
      ? $activeActivity.label + ($activeActivity.detail ? ` ${$activeActivity.detail}` : "")
      : "",
  );
  let typed = $state("");
  $effect(() => {
    const target = phrase;
    typed = "";
    if (!target) return;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      typed = target.slice(0, i);
      if (i >= target.length) clearInterval(id);
    }, 22);
    return () => clearInterval(id);
  });
</script>

{#if working && $activeActivity}
  <div class="loading-state">
    <span class="loading-label"><span class="shimmer">{typed}</span></span>
    <span class="loading-meta"
      >{time}{#if $activeActivity.steps > 0} · {$activeActivity.steps} step{$activeActivity.steps ===
          1
            ? ""
            : "s"}{/if}</span
    >
  </div>
{:else if $activeSummary}
  <!-- Idle: the last turn's summary stays here until the next turn starts. -->
  <div class="loading-state">
    <span class="loading-summary"
      >Finished in {humanTime($activeSummary.seconds)}{#if $activeSummary.steps > 0} · {$activeSummary.steps} step{$activeSummary.steps === 1 ? "" : "s"}{/if}</span
    >
  </div>
{/if}
