<script lang="ts">
  // Segmented toggle for the content view: Chat (icon) | Changes (diff stat) |
  // Run (script output). A single shared background slides to the active item
  // (see slidingToggle); each item has a tooltip. Changes only appears when the
  // worktree has changes, Run only once a script has run; clicking the active
  // one again returns to chat.
  import {
    mainView,
    setMainView,
    toggleMainView,
    activeGitStat,
    activeScriptRun,
    selectedWorktree,
  } from "../stores";
  import { Button } from "$lib/components/ui/button";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import FileDiff from "@lucide/svelte/icons/file-diff";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Terminal from "@lucide/svelte/icons/terminal";
  import { slidingToggle } from "../slidingHighlight";

  const stat = $derived($activeGitStat);
  // The tab shows whenever there's anything to review: dirty files OR commits
  // over the default branch — a clean-but-unmerged branch must keep its
  // PR/checks panel reachable (committing would otherwise hide the tab).
  const hasChanges = $derived(!!stat && (stat.changed > 0 || stat.aheadOfDefault > 0));
  // Untracked-only changes have a 0/0 diffstat (`git diff --shortstat HEAD`
  // doesn't see untracked files), so the ±counts alone would render a BLANK
  // button — fall back to an icon so the tab always has a face (also the face
  // of the clean-but-ahead state).
  const hasCounts = $derived(!!stat && (stat.insertions > 0 || stat.deletions > 0));
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
          onclick={() => setMainView("chat")}
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
            aria-label="Changes"
            onclick={() => toggleMainView("changes")}
          >
            {#if hasCounts}
              {#if stat.insertions > 0}<span class="diff-add">+{stat.insertions}</span>{/if}
              {#if stat.deletions > 0}<span class="diff-del">−{stat.deletions}</span>{/if}
            {:else}
              <FileDiff class="size-4" />
            {/if}
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
            onclick={() => toggleMainView("run")}
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
            onclick={() => toggleMainView("term")}
          >
            <Terminal class="size-4" />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Terminal</Tooltip.Content>
    </Tooltip.Root>
  {/if}
</div>

<style>
  /* Segmented view toggle: items sit above the sliding highlight (slidingToggle
     prepends a z-index:0 bg), which fills the active item. */
  .view-toggle {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    position: relative;
  }
  /* :global — the class lands on the rendered <button> inside the Button
     component, which doesn't carry this component's scope hash. */
  .view-toggle :global(.view-toggle-item) {
    position: relative;
    z-index: 1;
  }
  /* Diffstat counts on the Changes tab (added green / removed red, matching
     DiffView's line colors). */
  .diff-add {
    color: var(--base-success);
    font-variant-numeric: tabular-nums;
  }
  .diff-del {
    color: var(--app-danger);
    font-variant-numeric: tabular-nums;
  }
</style>
