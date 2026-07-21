<script lang="ts">
  // The chat-session strip — OUTSIDE the terminal card, on the shell band
  // between the header and the content frame (App.svelte mounts it there when
  // the chat surface is showing). Switches chats in tabs layout; acts as the
  // focus/close controls in grid layout. The cells themselves render inside
  // the card (ClaudeTerminalPane). Feature component.
  import {
    addChat,
    chatLayout,
    chatSessionsByWorktree,
    chatStatusByKey,
    DEFAULT_CHAT_ID,
    ensureDefaultChat,
    focusChat,
    focusedChatByWorktree,
    removeChat,
    selectedWorktree,
    setChatLayout,
  } from "../stores";
  import { claudeTermKey, disposeChatTerminal } from "../terminal";
  import IconButton from "./IconButton.svelte";
  import * as Tabs from "$lib/components/ui/tabs";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";

  const wt = $derived($selectedWorktree);
  // Seed the default chat on render (idempotent) — the strip is the chats
  // list's first reader, so the seeding effect lives here.
  $effect(() => {
    if (wt) ensureDefaultChat(wt);
  });
  const chats = $derived(wt ? ($chatSessionsByWorktree[wt] ?? []) : []);
  // The focused id, healed against the list (a persisted focus may point at a
  // chat closed in an earlier run).
  const focusedId = $derived.by(() => {
    const f = wt ? $focusedChatByWorktree[wt] : undefined;
    return chats.some((c) => c.id === f) ? (f as string) : (chats[0]?.id ?? DEFAULT_CHAT_ID);
  });
  const grid = $derived($chatLayout === "grid" && chats.length > 1);

  function close(id: string) {
    if (!wt) return;
    disposeChatTerminal(wt, id); // PTY + xterm; the transcript on disk stays
    removeChat(wt, id);
  }
</script>

{#if wt}
  <div class="chat-tabs">
    <Tabs.Root
      value={focusedId}
      onValueChange={(v: string) => v && wt && focusChat(wt, v)}
      class="min-w-0"
    >
      <Tabs.List>
        {#each chats as c, i (c.id)}
          <Tabs.Trigger value={c.id} class="chat-tab">
            <span
              class="chat-dot"
              data-status={$chatStatusByKey[claudeTermKey(wt, c.id)] ?? "stopped"}
            ></span>
            Chat {i + 1}
            {#if chats.length > 1}
              <span
                class="chat-close"
                role="button"
                tabindex="-1"
                aria-label="Close chat"
                onclick={(e: MouseEvent) => {
                  e.stopPropagation();
                  close(c.id);
                }}
                onkeydown={(e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    close(c.id);
                  }
                }}
              >
                <X class="size-3" />
              </span>
            {/if}
          </Tabs.Trigger>
        {/each}
      </Tabs.List>
    </Tabs.Root>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <IconButton {...props} aria-label="New chat" onclick={() => wt && addChat(wt)}>
            <Plus />
          </IconButton>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>New chat session in this worktree</Tooltip.Content>
    </Tooltip.Root>
    {#if chats.length > 1}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <IconButton
              {...props}
              aria-label={grid ? "Tab layout" : "Grid layout"}
              class={grid ? "text-foreground" : ""}
              onclick={() => setChatLayout(grid ? "tabs" : "grid")}
            >
              <LayoutGrid />
            </IconButton>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{grid ? "Show one chat (tabs)" : "Show all chats (grid)"}</Tooltip.Content>
      </Tooltip.Root>
    {/if}
  </div>
{/if}
