<!-- DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
     (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
     "Deprecated GUI surface" before extending. -->
<script lang="ts">
  // GUI⇄CLI chat-mode toggle for the header: swaps the selected worktree's
  // chat pane to the REAL Claude Code CLI TUI (and back), keeping the
  // conversation via the session-store handoff (session.ts ›
  // enterCliMode/exitCliMode). Deliberately NOT a ViewToggle item — ViewToggle
  // switches mainView panes; this switches the chat's ENGINE. Rendered only
  // when the provider declares a CLI (providers.ts › cliChat); disabled while
  // a turn streams (never kill a mid-turn sidecar). Feature component.
  import SquareChevronRight from "@lucide/svelte/icons/square-chevron-right";
  import { Button } from "$lib/components/ui/button";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { providerDisplay } from "../providers";
  import {
    activeChatMode,
    activeProvider,
    enterCliMode,
    exitCliMode,
    selectedWorktree,
    sessionStatus,
  } from "../stores";

  let error = $state(""); // command rejections land here (error-path rule (a))
  let switching = $state(false);

  const wt = $derived($selectedWorktree);
  const cliChat = $derived(providerDisplay($activeProvider).cliChat);
  const inCli = $derived($activeChatMode === "cli");
  const busy = $derived(!!wt && $sessionStatus[wt] === "busy");

  async function toggle() {
    const w = wt;
    if (!w || switching) return;
    error = "";
    switching = true;
    try {
      if (inCli) await exitCliMode(w);
      else await enterCliMode(w);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      switching = false;
    }
  }
</script>

{#if wt && cliChat}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          size="icon-sm"
          variant="ghost"
          class="size-7 text-muted-foreground hover:text-foreground data-[active]:text-foreground"
          data-active={inCli ? "" : undefined}
          aria-label={cliChat.toggleLabel}
          disabled={busy || switching}
          onclick={toggle}
        >
          <SquareChevronRight class="size-4" />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>
      {#if error}
        {error}
      {:else if busy}
        Wait for the turn to finish
      {:else if inCli}
        Return to the chat UI
      {:else}
        {cliChat.description}
      {/if}
    </Tooltip.Content>
  </Tooltip.Root>
{/if}