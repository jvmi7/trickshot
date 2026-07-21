<script lang="ts">
  // Fleet overview — mission control for every worktree across repos: status
  // dot (working/idle/off), unread badge, live ± diffstat, and
  // commits-over-base, each card a click-to-jump. Rendered in the center pane
  // when repos exist but NO worktree is selected (the former "select a
  // worktree on the left" dead end); the palette's "Fleet overview" deselects
  // to get here. Feature component (reads stores by design).
  import {
    activateWorktree,
    gitStatByWorktree,
    repos,
    requestNewWorktree,
    sessionStatus,
    unreadByWorktree,
    worktreesByRepo,
  } from "../stores";
  import { profileAccent } from "../termProfiles";
  import { Button } from "$lib/components/ui/button";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Plus from "@lucide/svelte/icons/plus";

  let error = $state("");

  async function open(path: string) {
    error = "";
    try {
      await activateWorktree(path);
    } catch (e) {
      error = String(e);
    }
  }

  /** Human status for a worktree's card. */
  function statusLabel(path: string): { label: string; kind: "busy" | "on" | "off" } {
    const s = $sessionStatus[path];
    if (s === "busy") return { label: "working…", kind: "busy" };
    if (s === "ready") return { label: "idle", kind: "on" };
    return { label: "off", kind: "off" };
  }
</script>

<div class="fleet">
  <div class="fleet-head">
    <span class="section-label">All workspaces</span>
    <span class="panel-spacer"></span>
    <Button size="sm" variant="outline" class="h-7 text-xs" onclick={requestNewWorktree}>
      <Plus class="size-3.5" /> New worktree
    </Button>
  </div>
  {#if error}
    <div class="fleet-error error-text">{error}</div>
  {/if}

  {#each $repos as repo (repo.path)}
    <div class="fleet-repo">
      <span class="section-label">{repo.name}</span>
      <div class="fleet-grid">
        {#each $worktreesByRepo[repo.path] ?? [] as wt (wt.path)}
          {@const st = statusLabel(wt.path)}
          {@const gs = $gitStatByWorktree[wt.path]}
          <button class="fleet-card" onclick={() => open(wt.path)} title={wt.path}>
            <div class="fleet-card-head">
              <span class="shrink-0" style="color: {profileAccent(wt.path)}"><GitBranch class="size-3.5" /></span>
              <span class="fleet-branch">{wt.branch ?? "(detached)"}</span>
              {#if ($unreadByWorktree[wt.path] ?? 0) > 0}
                <span class="fleet-unread">{$unreadByWorktree[wt.path]}</span>
              {/if}
            </div>
            <div class="fleet-card-meta">
              <span class="fleet-status" data-kind={st.kind}>
                <span class="fleet-dot"></span>
                {st.label}
              </span>
              {#if gs && gs.changed > 0}
                <span class="fleet-diff">
                  {#if gs.insertions}<span class="diff-add">+{gs.insertions}</span>{/if}
                  {#if gs.deletions}<span class="diff-del">−{gs.deletions}</span>{/if}
                  {#if !gs.insertions && !gs.deletions}{gs.changed} changed{/if}
                </span>
              {/if}
              {#if gs && gs.aheadOfDefault > 0}
                <span class="fleet-ahead" title="Commits over the default branch">↑{gs.aheadOfDefault}</span>
              {/if}
            </div>
          </button>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  /* Fleet layout is one-component structural CSS (split-by-reach); colors and
     type come from the shared tokens. */
  .fleet {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 20px 24px;
  }
  .fleet-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .fleet-error {
    margin-bottom: 8px;
  }
  .fleet-repo {
    margin-bottom: 20px;
  }
  .fleet-grid {
    margin-top: 8px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
  }
  .fleet-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    text-align: left;
    font: inherit;
    color: inherit;
    background: var(--app-panel);
    border: 1px solid var(--app-border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition:
      background var(--app-duration-fast),
      border-color var(--app-duration-fast);
  }
  .fleet-card:hover {
    background: var(--app-panel-2);
    border-color: color-mix(in oklch, var(--app-accent) 45%, var(--app-border));
  }
  .fleet-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .fleet-branch {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .fleet-card-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  .fleet-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .fleet-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--app-border);
  }
  .fleet-status[data-kind="on"] .fleet-dot {
    background: var(--base-success);
  }
  .fleet-status[data-kind="busy"] .fleet-dot {
    background: var(--base-warning);
  }
  .fleet-diff {
    display: inline-flex;
    gap: 4px;
  }
  .fleet-ahead {
    color: var(--app-dim);
  }
  /* Badge twin of the sidebar's wt-unread, card-scaled. */
  .fleet-unread {
    flex-shrink: 0;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-2xs);
    font-weight: 700;
    border-radius: var(--radius-2xs);
    background: var(--app-accent);
    color: var(--base-on-accent);
  }
</style>
