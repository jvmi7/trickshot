<script lang="ts">
  // The chat surface INSIDE the content card: one worktree's concurrent CLI
  // chats — the focused chat's cell (tabs layout) or a split-tree mosaic of
  // all of them (grid layout). The strip that switches/closes/adds chats
  // lives OUTSIDE the card (ChatTabs.svelte); the MODEL is the chats store +
  // the split tree, and both components render from it. Adding terminals in
  // grid mode is right-click → split up/down/left/right (tmux-style): the
  // new chat takes the chosen half of the clicked cell. Feature component.
  import {
    chatLayout,
    chatSessionsByWorktree,
    chatSplitByWorktree,
    chatStatusByKey,
    closeChat,
    DEFAULT_CHAT_ID,
    focusChat,
    focusedChatByWorktree,
    selectedWorktree,
    setChatLayout,
    splitChat,
  } from "../stores";
  import { borderGlow } from "../borderGlow";
  import { heal, type SplitWhere, treeToGrid } from "../splitTree";
  import { claudeTermKey } from "../terminal";
  import ClaudeTerminalCell from "./ClaudeTerminalCell.svelte";
  import IconButton from "./IconButton.svelte";
  import * as ContextMenu from "$lib/components/ui/context-menu";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import PanelTop from "@lucide/svelte/icons/panel-top";
  import SquareSplitHorizontal from "@lucide/svelte/icons/square-split-horizontal";
  import SquareSplitVertical from "@lucide/svelte/icons/square-split-vertical";
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
  // The mosaic: the persisted split tree healed against the live chat list
  // (dead leaves pruned, appended chats placed), flattened to ONE flat CSS
  // grid — cells stay direct children of .chat-grid so the trail silhouette's
  // observers and union query work unchanged.
  const layout = $derived.by(() => {
    if (!grid) return null;
    const tree = heal(wt ? $chatSplitByWorktree[wt] : undefined, chats.map((c) => c.id));
    return tree ? treeToGrid(tree) : null;
  });

  const SPLITS: { where: SplitWhere; label: string; vertical: boolean }[] = [
    { where: "right", label: "Split right", vertical: false },
    { where: "left", label: "Split left", vertical: false },
    { where: "down", label: "Split down", vertical: true },
    { where: "up", label: "Split up", vertical: true },
  ];
</script>

{#snippet cellMenu(chatId: string)}
  <ContextMenu.Content>
    {#each SPLITS as s (s.where)}
      <ContextMenu.Item onclick={() => wt && splitChat(wt, chatId, s.where)}>
        {#if s.vertical}
          <SquareSplitVertical class="size-3.5" />
        {:else}
          <SquareSplitHorizontal class="size-3.5" />
        {/if}
        {s.label}
      </ContextMenu.Item>
    {/each}
    {#if chats.length > 1}
      <ContextMenu.Separator />
      <ContextMenu.Item variant="destructive" onclick={() => wt && closeChat(wt, chatId)}>
        <X class="size-3.5" />
        Close chat
      </ContextMenu.Item>
      <ContextMenu.Separator />
      {#if grid}
        <ContextMenu.Item onclick={() => setChatLayout("tabs")}>
          <PanelTop class="size-3.5" />
          Tab layout
        </ContextMenu.Item>
      {:else}
        <ContextMenu.Item onclick={() => setChatLayout("grid")}>
          <LayoutGrid class="size-3.5" />
          Grid layout
        </ContextMenu.Item>
      {/if}
    {/if}
  </ContextMenu.Content>
{/snippet}

{#if wt}
  {#if grid && layout}
    <div class="chat-grid" style="grid-template-columns: {layout.cols}; grid-template-rows: {layout.rows}">
      {#each layout.cells as cell (cell.chat)}
        <!-- The Trigger's child snippet spreads the contextmenu props onto
             the CELL itself — a wrapper element would break its grid-area. -->
        <!-- focusin (not click): focusing the cell's terminal — however it
             happens — routes injected turns to it. Bubbles from xterm's
             hidden textarea; no interactive-element a11y surface needed. -->
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            {#snippet child({ props })}
              <div
                {...props}
                class="chat-grid-cell"
                style="grid-area: {cell.area}"
                use:borderGlow
                onfocusin={() => focusChat(wt, cell.chat)}
              >
                <ClaudeTerminalCell worktree={wt} chatId={cell.chat} />
                <div class="chat-cell-controls">
                  <span
                    class="chat-dot"
                    data-status={$chatStatusByKey[claudeTermKey(wt, cell.chat)] ?? "stopped"}
                  ></span>
                  {#if chats.length > 1}
                    <IconButton aria-label="Close chat" onclick={() => wt && closeChat(wt, cell.chat)}>
                      <X />
                    </IconButton>
                  {/if}
                </div>
              </div>
            {/snippet}
          </ContextMenu.Trigger>
          {@render cellMenu(cell.chat)}
        </ContextMenu.Root>
      {/each}
    </div>
  {:else}
    <!-- The same split menu works from tabs layout: splitting jumps to grid
         with both halves showing. -->
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        {#snippet child({ props })}
          <div {...props} class="chat-solo">
            <ClaudeTerminalCell worktree={wt} chatId={focusedId} />
          </div>
        {/snippet}
      </ContextMenu.Trigger>
      {@render cellMenu(focusedId)}
    </ContextMenu.Root>
  {/if}
{/if}
