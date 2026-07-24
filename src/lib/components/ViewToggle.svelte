<script lang="ts">
  // Segmented toggle for the content view: Chat (icon) | Changes (diff stat) |
  // Run (script output). A single shared background slides to the active item
  // (see slidingToggle); each item has a tooltip. Changes only appears when the
  // worktree has changes, Run only once a script has run; clicking the active
  // one again returns to chat.
  import {
    mainView,
    toggleMainView,
    activeGitStat,
    activeScriptRun,
    changesOpen,
    setChangesOpen,
    shellOpen,
    setShellOpen,
    selectedWorktree,
  } from "../stores";
  import GitPanel from "./GitPanel.svelte";
  import TerminalPane from "./TerminalPane.svelte";
  import * as Popover from "$lib/components/ui/popover";
  import { Button } from "$lib/components/ui/button";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import FileDiff from "@lucide/svelte/icons/file-diff";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Terminal from "@lucide/svelte/icons/terminal";
  import { slidingToggle } from "../slidingHighlight";

  // ONE chrome for both header popovers (Changes, Shell): the app float
  // shadow, top-of-ladder radius, and clipped corners so the panel inside
  // meets the ring cleanly. The panels own their size (.git-panel /
  // .term-pane-popover); the popover shell stays w-auto p-0.
  const headerPopoverClass =
    "w-auto overflow-hidden rounded-xl p-0 [box-shadow:var(--app-shadow-float)]";

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
  {#if hasChanges && stat}
    <!-- Changes is a POPOVER over the terminal (not a page swap): the ± trigger
         drops the whole git panel in place. -->
    <Popover.Root open={$changesOpen} onOpenChange={setChangesOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="sm"
            variant="ghost"
            class="view-toggle-item h-8 gap-1.5 text-sm text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:text-foreground data-[active]:text-foreground"
            data-active={$changesOpen ? "" : undefined}
            aria-label="Changes"
            title="Changes & pull request"
          >
            {#if hasCounts}
              {#if stat.insertions > 0}<span class="diff-add">+{stat.insertions}</span>{/if}
              {#if stat.deletions > 0}<span class="diff-del">−{stat.deletions}</span>{/if}
            {:else}
              <FileDiff class="size-4.5" />
            {/if}
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content align="end" sideOffset={8} class={headerPopoverClass}>
        <GitPanel />
      </Popover.Content>
    </Popover.Root>
  {/if}

  {#if scriptRun}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="icon-sm"
            variant="ghost"
            class="view-toggle-item size-8 text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:text-foreground data-[active]:text-foreground"
            data-active={$mainView === "run" ? "" : undefined}
            aria-label="Run output"
            onclick={() => toggleMainView("run")}
          >
            <SquareTerminal class="size-4.5 {scriptRun.status === 'running' ? 'text-[var(--base-success)]' : ''}" />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Run output ({scriptRun.name})</Tooltip.Content>
    </Tooltip.Root>
  {/if}

  {#if $selectedWorktree}
    <!-- Shell is a POPOVER whose session PERSISTS across open/close (the PTY +
         xterm live in the instance cache; the popover only re-parents them).
         Esc is IGNORED so it reaches the shell — vim lives there; close by
         clicking outside or re-clicking the trigger. -->
    <Popover.Root open={$shellOpen} onOpenChange={setShellOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="icon-sm"
            variant="ghost"
            class="view-toggle-item size-8 text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:text-foreground data-[active]:text-foreground"
            data-active={$shellOpen ? "" : undefined}
            aria-label="Shell"
            title="Shell — a plain terminal in this worktree (the chat pane is the Claude CLI)"
          >
            <Terminal class="size-4.5" />
          </Button>
        {/snippet}
      </Popover.Trigger>
      <!-- animate-none: xterm measures its glyph cells at attach; the default
           zoom-in transform scales those measurements and garbles the grid. -->
      <Popover.Content
        align="end"
        sideOffset={8}
        class="{headerPopoverClass} data-[state=open]:animate-none data-[state=closed]:animate-none"
        escapeKeydownBehavior="ignore"
      >
        <TerminalPane />
      </Popover.Content>
    </Popover.Root>
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
  /* Diffstat counts use the shared .diff-add/.diff-del (app.css) — promoted
     there when GitPanel's file rows adopted the same shape. */
</style>
