<script lang="ts">
  import {
    archivedWorkspaces,
    removeArchived,
    restoreWorkspace,
    type ArchivedWorkspace,
  } from "../stores";
  import { slidingRowHighlight } from "../slidingHighlight";
  import { relativeTime } from "../utils";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import IconButton from "./IconButton.svelte";
  import Archive from "@lucide/svelte/icons/archive";
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  // Collapsed by default every launch — the archived list is peripheral, so
  // its disclosure is deliberately ephemeral (not persisted).
  let expanded = $state(false);
  let error = $state("");
  // The confirm Dialog's pending action: both variants drop History entries
  // for good (the live-workspace confirms stay in Worktrees).
  type ConfirmAction = { kind: "purge"; entry: ArchivedWorkspace } | { kind: "purge-all" };
  let confirmAction = $state<ConfirmAction | null>(null);

  // Restore an archived workspace — the shared flow lives in session.ts
  // (`restoreWorkspace`, also the palette's path); this just owns the
  // section's local error surface.
  async function restoreArchived(entry: ArchivedWorkspace) {
    error = "";
    try {
      await restoreWorkspace(entry);
    } catch (e) {
      error = String(e);
    }
  }

  // Permanently delete an archived workspace: drop the History entry. (The
  // conversation itself lives in Claude Code's own session store on disk —
  // the app never deletes that.)
  function purgeArchived(entry: ArchivedWorkspace) {
    removeArchived(entry.repoPath, entry.branch);
  }

  // The confirm Dialog's OK: run whichever purge was pending.
  function confirmProceed() {
    const c = confirmAction;
    confirmAction = null;
    if (!c) return;
    if (c.kind === "purge") purgeArchived(c.entry);
    // Iterate a COPY: purgeArchived mutates the store per entry.
    else for (const a of [...$archivedWorkspaces]) purgeArchived(a);
  }
</script>

{#if $archivedWorkspaces.length > 0}
  <div class="archived-section">
    <div class="wt-section archived-head group/arch">
      <button class="repo-toggle" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
        <span class="repo-chevron" class:collapsed={!expanded}><ChevronDown class="size-3.5" /></span>
        <span class="repo-name section-label">Archived</span>
        <span class="arch-count">{$archivedWorkspaces.length}</span>
      </button>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <IconButton
              {...props}
              class="opacity-0 transition-opacity group-hover/arch:opacity-100"
              aria-label="Clear all archived workspaces"
              onclick={() => (confirmAction = { kind: "purge-all" })}
            >
              <Trash2 />
            </IconButton>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Clear all (removes them from History)</Tooltip.Content>
      </Tooltip.Root>
    </div>
    {#if expanded}
      <div class="wt-rows archived-list" use:slidingRowHighlight>
        {#each $archivedWorkspaces as a (a.repoPath + " " + a.branch)}
          <div class="wt-row group/row archived-row">
            <Archive class="wt-home" />
            <span class="wt-name" title="{a.repoName} · {a.branch}">{a.repoName} / {a.branch}</span>
            <span
              class="arch-time"
              title={new Date(a.archivedAt).toLocaleString()}
            >{relativeTime(a.archivedAt)}</span>
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    variant="ghost"
                    size="icon-xs"
                    class="opacity-0 transition-opacity group-hover/row:opacity-100"
                    aria-label="Restore workspace"
                    onclick={() => restoreArchived(a)}
                  >
                    <ArchiveRestore class="size-3" />
                  </Button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>Restore (recreates the worktree, chat resumes)</Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    variant="ghost"
                    size="icon-xs"
                    class="opacity-0 transition-opacity group-hover/row:opacity-100"
                    aria-label="Delete permanently"
                    onclick={() => (confirmAction = { kind: "purge", entry: a })}
                  >
                    <Trash2 class="size-3" />
                  </Button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>Delete permanently (removes it from History)</Tooltip.Content>
            </Tooltip.Root>
          </div>
        {/each}
      </div>
    {/if}
    {#if error}<div class="error-text">{error}</div>{/if}
  </div>
{/if}

<Dialog.Root open={!!confirmAction} onOpenChange={(open) => !open && (confirmAction = null)}>
  <Dialog.Content>
    <Dialog.Header>
      {#if confirmAction?.kind === "purge"}
        <Dialog.Title>Delete archived workspace?</Dialog.Title>
        <Dialog.Description>
          "{confirmAction.entry.repoName} / {confirmAction.entry.branch}" is removed from History
          (the git branch is kept).
        </Dialog.Description>
      {:else if confirmAction?.kind === "purge-all"}
        <Dialog.Title>Clear all archived workspaces?</Dialog.Title>
        <Dialog.Description>
          All {$archivedWorkspaces.length} archived workspace{$archivedWorkspaces.length === 1
            ? ""
            : "s"} are removed from History (git branches are kept).
        </Dialog.Description>
      {/if}
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => (confirmAction = null)}>Cancel</Button>
      <Button variant="destructive" onclick={confirmProceed}>
        {confirmAction?.kind === "purge" ? "Delete" : "Delete all"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
