<script lang="ts">
  // Header notification bell: the in-app history of cross-worktree events
  // (agent finished / needs attention) with click-to-jump. The OS notification
  // is easy to miss or dismissed — this is the durable(-ish, session-only)
  // record. Feature component (reads stores by design).
  import {
    activateWorktree,
    appNotifications,
    clearAppNotifications,
    markNotificationsSeen,
    notificationsSeenAt,
  } from "../stores";
  import { basename, relativeTime } from "../utils";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import Bell from "@lucide/svelte/icons/bell";

  const unseen = $derived($appNotifications.filter((n) => n.at > $notificationsSeenAt).length);

  // now-tick so the relative ages don't fossilize while the menu sits open.
  let now = $state(Date.now());
  function onOpenChange(open: boolean) {
    if (open) {
      now = Date.now();
      markNotificationsSeen();
    }
  }
</script>

{#if $appNotifications.length > 0 || unseen > 0}
  <DropdownMenu.Root {onOpenChange}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          size="icon-sm"
          variant="ghost"
          class="relative size-7 text-muted-foreground hover:text-foreground"
          aria-label="Notifications"
          title="Notifications"
        >
          <Bell class="size-4" />
          {#if unseen > 0}
            <span class="bell-count">{unseen > 9 ? "9+" : unseen}</span>
          {/if}
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="w-72">
      {#each $appNotifications as n (n.id)}
        <DropdownMenu.Item onclick={() => void activateWorktree(n.worktree).catch(() => {})}>
          <div class="bell-row">
            <span class="bell-title">{n.title === basename(n.worktree) ? n.body : n.title}</span>
            <span class="bell-meta">{basename(n.worktree)} · {relativeTime(n.at, now)}</span>
          </div>
        </DropdownMenu.Item>
      {/each}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onclick={clearAppNotifications}>Clear all</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

<style>
  .bell-count {
    position: absolute;
    top: 0;
    right: 0;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-2xs);
    font-weight: 700;
    border-radius: var(--radius-2xs);
    background: var(--app-accent);
    color: var(--base-on-accent);
  }
  .bell-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .bell-title {
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bell-meta {
    font-size: var(--text-2xs);
    color: var(--app-dim);
  }
</style>
