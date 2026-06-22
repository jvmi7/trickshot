<script lang="ts">
  import { activeActivity, selectedWorktree, sessionStatus } from "../stores";

  // tick the elapsed timer once a second while a turn is running.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  const status = $derived($selectedWorktree ? $sessionStatus[$selectedWorktree] : undefined);
  const working = $derived(status === "working");
  const elapsed = $derived(
    $activeActivity ? Math.max(0, Math.floor((now - $activeActivity.startedAt) / 1000)) : 0,
  );
  const time = $derived(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`);
</script>

{#if working && $activeActivity}
  <div class="loading-state">
    <span class="loading-dots"><i></i><i></i><i></i></span>
    <div class="loading-text">
      <div class="loading-label">
        {$activeActivity.label}{#if $activeActivity.detail}<span class="loading-detail"
            >&nbsp;{$activeActivity.detail}</span
          >{/if}
      </div>
      <div class="loading-meta">
        {time}{#if $activeActivity.steps > 0}
          · {$activeActivity.steps} step{$activeActivity.steps === 1 ? "" : "s"}{/if}
      </div>
    </div>
  </div>
{/if}
