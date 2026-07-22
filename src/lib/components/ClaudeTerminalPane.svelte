<script lang="ts">
  // The chat surface INSIDE the content card: one worktree's concurrent CLI
  // chats — the focused chat's cell (tabs layout) or an n-up grid of all of
  // them. The strip that switches/closes/adds chats lives OUTSIDE the card
  // (ChatTabs.svelte, mounted above the frame in App.svelte); the MODEL is
  // the chats store, and both components render from it. In GRID mode the
  // strip collapses, so the per-chat controls (status dot + ✕, hover-faded)
  // and the +/layout cluster live here instead. Feature component.
  import {
    addChat,
    chatLayout,
    chatSessionsByWorktree,
    chatStatusByKey,
    closeChat,
    DEFAULT_CHAT_ID,
    focusChat,
    focusedChatByWorktree,
    selectedWorktree,
    setChatLayout,
  } from "../stores";
  import { borderGlow } from "../borderGlow";
  import { claudeTermKey } from "../terminal";
  import ClaudeTerminalCell from "./ClaudeTerminalCell.svelte";
  import IconButton from "./IconButton.svelte";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import PanelTop from "@lucide/svelte/icons/panel-top";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";

  const wt = $derived($selectedWorktree);
  // ChatTabs seeds the default chat; the fallback below covers the first tick.
  const chats = $derived(wt ? ($chatSessionsByWorktree[wt] ?? []) : []);
  // The focused id, healed against the list (a persisted focus may point at a
  // chat closed in an earlier run).
  const focusedId = $derived.by(() => {
    const f = wt ? $focusedChatByWorktree[wt] : undefined;
    return chats.some((c) => c.id === f) ? (f as string) : (chats[0]?.id ?? DEFAULT_CHAT_ID);
  });
  const grid = $derived($chatLayout === "grid" && chats.length > 1);
  // n-up shape over TILES = chats + the ghost add-slot (grid mode only runs
  // at ≥2 chats, so ≥3 tiles): up to a 2×2, beyond that 3 columns.
  const cols = $derived(chats.length + 1 <= 4 ? 2 : 3);
</script>

{#if wt}
  {#if grid}
    <div class="chat-grid" style="--chat-cols: {cols}">
      {#each chats as c (c.id)}
        <!-- focusin (not click): focusing the cell's terminal — however it
             happens — routes injected turns to it. Bubbles from xterm's
             hidden textarea; no interactive-element a11y surface needed. -->
        <div class="chat-grid-cell" use:borderGlow onfocusin={() => focusChat(wt, c.id)}>
          <ClaudeTerminalCell worktree={wt} chatId={c.id} />
          <div class="chat-cell-controls">
            <span
              class="chat-dot"
              data-status={$chatStatusByKey[claudeTermKey(wt, c.id)] ?? "stopped"}
            ></span>
            {#if chats.length > 1}
              <IconButton aria-label="Close chat" onclick={() => wt && closeChat(wt, c.id)}>
                <X />
              </IconButton>
            {/if}
          </div>
        </div>
      {/each}
      <!-- Ghost add-slot: the always-present last tile. NOT a .chat-grid-cell,
           so the silhouette skips it — the trail surface doesn't wash into an
           empty slot. Clicking converts it: the new terminal mounts here and
           the ghost flows on. -->
      <button
        type="button"
        class="chat-grid-ghost"
        aria-label="New chat"
        onclick={() => wt && addChat(wt)}
      >
        <Plus />
      </button>
    </div>
    <div class="chat-grid-controls">
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <IconButton {...props} aria-label="Tab layout" onclick={() => setChatLayout("tabs")}>
              <PanelTop />
            </IconButton>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Show one chat (tabs)</Tooltip.Content>
      </Tooltip.Root>
    </div>
  {:else}
    <ClaudeTerminalCell worktree={wt} chatId={focusedId} />
  {/if}
{/if}
