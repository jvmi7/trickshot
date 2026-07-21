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
  import { borderGlow } from "../borderGlow";
  import { cursorTrail } from "../cursorTrail";
  import { claudeTermKey, disposeChatTerminal } from "../terminal";
  import IconButton from "./IconButton.svelte";
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
  <!-- Hand-rolled tabs (NOT ui/tabs — a deliberate exception): the connected
       Chrome-style chrome (card-bg fill, top radius, concave flares, border
       overlap) is bespoke app chrome the registry trigger's own utility
       styles can't be overridden into. Styled in app.css › .chat-tab. -->
  <!-- data-first-active drives the flush-left merge (app.css): the card and
       its glow ring square their top-left corner under the first tab. -->
  <div
    class="chat-tabs"
    role="tablist"
    aria-label="Chat sessions"
    data-first-active={chats[0]?.id === focusedId ? "" : undefined}
  >
    {#each chats as c, i (c.id)}
      <!-- use:borderGlow per tab: the action writes ITS node-relative glow
           vars, so the tab's ring overlay (below) lights in the same sweep as
           the card frame — one continuous cursor effect across both. -->
      <button
        type="button"
        role="tab"
        class="chat-tab"
        aria-selected={c.id === focusedId}
        data-active={c.id === focusedId ? "" : undefined}
        onclick={() => focusChat(wt, c.id)}
        use:borderGlow
      >
        {#if c.id === focusedId}
          <!-- The tab shares the terminal backdrop's trailing-cursor surface:
               its own trail canvas, viewport-grid-aligned with the cell's, so
               the pixel wake flows continuously between card and tab. -->
          <span class="chat-tab-bg" aria-hidden="true" use:cursorTrail={{ reach: true }}></span>
        {/if}
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
        {#if c.id === focusedId}
          <!-- Three SIBLING layers, not pseudos of one: a mask clips the
               element AND its pseudos, so arcs hanging off the masked ring
               span would be cropped to slivers. Siblings mask independently. -->
          <span class="chat-tab-glow" aria-hidden="true"></span>
          <span class="chat-tab-glow-arc" data-side="left" aria-hidden="true"></span>
          <span class="chat-tab-glow-arc" data-side="right" aria-hidden="true"></span>
        {/if}
      </button>
    {/each}
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
