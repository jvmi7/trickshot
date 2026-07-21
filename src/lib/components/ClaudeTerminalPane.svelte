<script lang="ts">
  // The chat surface INSIDE the content card: one worktree's concurrent CLI
  // chats — the focused chat's cell (tabs layout) or an n-up grid of all of
  // them. The strip that switches/closes/adds chats lives OUTSIDE the card
  // (ChatTabs.svelte, mounted above the frame in App.svelte); the MODEL is
  // the chats store, and both components render from it. Feature component.
  import {
    chatLayout,
    chatSessionsByWorktree,
    DEFAULT_CHAT_ID,
    focusChat,
    focusedChatByWorktree,
    selectedWorktree,
  } from "../stores";
  import ClaudeTerminalCell from "./ClaudeTerminalCell.svelte";

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
  // n-up shape: 2 side-by-side, 3-4 in a 2×2, beyond that 3 columns.
  const cols = $derived(chats.length <= 1 ? 1 : chats.length <= 4 ? 2 : 3);
</script>

{#if wt}
  {#if grid}
    <div class="chat-grid" style="--chat-cols: {cols}">
      {#each chats as c (c.id)}
        <!-- focusin (not click): focusing the cell's terminal — however it
             happens — routes injected turns to it. Bubbles from xterm's
             hidden textarea; no interactive-element a11y surface needed. -->
        <div class="chat-grid-cell" onfocusin={() => focusChat(wt, c.id)}>
          <ClaudeTerminalCell worktree={wt} chatId={c.id} />
        </div>
      {/each}
    </div>
  {:else}
    <ClaudeTerminalCell worktree={wt} chatId={focusedId} />
  {/if}
{/if}
