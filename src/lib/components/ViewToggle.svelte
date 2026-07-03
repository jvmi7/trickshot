<script lang="ts">
  // Segmented toggle for the content view: Chat (icon) | Changes (diff stat) |
  // Run (script output). A single shared background slides to the active item
  // (see slidingToggle); each item has a tooltip. Changes only appears when the
  // worktree has changes, Run only once a script has run; clicking the active
  // one again returns to chat.
  import { mainView, activeGitStat, activeScriptRun, selectedWorktree } from "../stores";
  import { Button } from "$lib/components/ui/button";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Terminal from "@lucide/svelte/icons/terminal";
  import { slidingToggle } from "../slidingHighlight";

  const stat = $derived($activeGitStat);
  const hasChanges = $derived(!!stat && stat.changed > 0);
  const scriptRun = $derived($activeScriptRun);
</script>

<div class="view-toggle" use:slidingToggle>
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          size="icon-sm"
          variant="ghost"
          class="view-toggle-item size-7 text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:text-foreground data-[active]:text-foreground"
          data-active={$mainView === "chat" ? "" : undefined}
          aria-label="Chat"
          onclick={() => mainView.set("chat")}
        >
          <MessageSquare class="size-4" />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>Chat</Tooltip.Content>
  </Tooltip.Root>

  {#if hasChanges && stat}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="sm"
            variant="ghost"
            class="view-toggle-item h-7 gap-1.5 text-xs text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:text-foreground data-[active]:text-foreground"
            data-active={$mainView === "changes" ? "" : undefined}
            onclick={() => mainView.set($mainView === "changes" ? "chat" : "changes")}
          >
            {#if stat.insertions > 0}<span class="diff-add">+{stat.insertions}</span>{/if}
            {#if stat.deletions > 0}<span class="diff-del">−{stat.deletions}</span>{/if}
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Changes</Tooltip.Content>
    </Tooltip.Root>
  {/if}

  {#if scriptRun}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="icon-sm"
            variant="ghost"
            class="view-toggle-item size-7 text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:text-foreground data-[active]:text-foreground"
            data-active={$mainView === "run" ? "" : undefined}
            aria-label="Run output"
            onclick={() => mainView.set($mainView === "run" ? "chat" : "run")}
          >
            <SquareTerminal class="size-4 {scriptRun.status === 'running' ? 'text-[var(--base-success)]' : ''}" />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Run output ({scriptRun.name})</Tooltip.Content>
    </Tooltip.Root>
  {/if}

  {#if $selectedWorktree}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="icon-sm"
            variant="ghost"
            class="view-toggle-item size-7 text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:text-foreground data-[active]:text-foreground"
            data-active={$mainView === "term" ? "" : undefined}
            aria-label="Terminal"
            onclick={() => mainView.set($mainView === "term" ? "chat" : "term")}
          >
            <Terminal class="size-4" />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Terminal</Tooltip.Content>
    </Tooltip.Root>
  {/if}
</div>
