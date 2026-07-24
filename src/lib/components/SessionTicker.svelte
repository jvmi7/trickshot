<script lang="ts">
  // Header running-sessions indicator: ONE morphing swatch per busy chat —
  // each running instance shows its workspace's identity mark in the loading
  // morph (the sidebar/tab/grid signal, stacked). The stack anchors RIGHT
  // (it leads the right-aligned header actions cluster) and grows LEFTWARD
  // as instances start. Hidden at zero. Feature component (reads stores).
  import { chatStatusByKey } from "../stores";
  import { keyWorktree } from "../terminal";
  import { profileAccent } from "../termProfiles";
  import { basename } from "$lib/utils";
  import IdentityGlyph from "./IdentityGlyph.svelte";

  // One entry per busy chat KEY (a worktree can run several chats — each
  // gets its own swatch, all in that workspace's palette).
  const busy = $derived(
    Object.entries($chatStatusByKey)
      .filter(([, s]) => s === "busy")
      .map(([key]) => ({ key, wt: keyWorktree(key) })),
  );
</script>

{#if busy.length > 0}
  <div
    class="session-stack"
    role="status"
    aria-label="{busy.length} running session{busy.length === 1 ? '' : 's'}"
  >
    {#each busy as b (b.key)}
      <span class="stack-swatch" title="{basename(b.wt)} — working…">
        <IdentityGlyph seed={b.wt} color={profileAccent(b.wt)} size={12} loading={true} />
      </span>
    {/each}
    <!-- The count rides the stack's fixed RIGHT edge; the digit rolls on
         change (the swatches grow away leftward, the number stays put). -->
    {#key busy.length}
      <span class="stack-count">{busy.length}</span>
    {/key}
  </div>
{/if}

<style>
  /* Avatar-stack of live swatches: slight overlap; the cluster sits at the
     header's right edge, so added swatches extend the row leftward. */
  .session-stack {
    display: inline-flex;
    align-items: center;
  }
  .stack-swatch {
    display: inline-flex;
    align-items: center;
  }
  .stack-swatch + .stack-swatch {
    margin-left: -3px;
  }
  .stack-count {
    margin-left: 6px;
    min-width: 1ch;
    font-size: var(--text-xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--app-dim);
    animation: count-roll 220ms var(--ease-out-soft);
  }
  @keyframes count-roll {
    from {
      transform: translateY(0.55em);
      opacity: 0;
    }
  }
</style>
