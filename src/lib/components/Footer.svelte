<script lang="ts">
  // The status FOOTER: a slim band under the terminal card (the header's
  // quiet sibling). Home of the subscription usage chip and small ambient
  // items — add here, not to the header, when something belongs "below the
  // work". Feature component (stores wiring).
  import { repos, selectedWorktree, toggleCommandPalette, worktreesByRepo } from "../stores";
  import UsageIndicator from "./UsageIndicator.svelte";
  import Command from "@lucide/svelte/icons/command";
  import GitBranch from "@lucide/svelte/icons/git-branch";

  // The selected worktree's branch (the terminal's status-bar staple).
  const branch = $derived.by(() => {
    const sel = $selectedWorktree;
    if (!sel) return null;
    for (const r of $repos) {
      const wt = ($worktreesByRepo[r.path] ?? []).find((w) => w.path === sel);
      if (wt) return wt.branch ?? "(detached)";
    }
    return null;
  });
</script>

{#if $repos.length > 0}
  <footer class="app-footer">
    <button type="button" class="footer-hint" onclick={toggleCommandPalette}>
      <Command /> P
      <span class="footer-hint-label">shortcuts</span>
    </button>
    {#if branch}
      <span class="footer-branch"><GitBranch /> {branch}</span>
    {/if}
    <span class="footer-spacer"></span>
    <UsageIndicator />
  </footer>
{/if}
