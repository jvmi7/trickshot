<script lang="ts">
  import {
    renderedGroups,
    hiddenMessageCount,
    selectedWorktree,
    scrollCursor,
  } from "../stores";
  import { customScroll } from "../customScroll";
  import Message from "./Message.svelte";
  import ToolGroup from "./ToolGroup.svelte";
  import Composer from "./Composer.svelte";
  import Suggestions from "./Suggestions.svelte";
  import PermissionModal from "./PermissionModal.svelte";
  import QuestionModal from "./QuestionModal.svelte";
  import ScrollIndicator from "./ScrollIndicator.svelte";
  import LoadingState from "./LoadingState.svelte";
  import CommentLayer from "./CommentLayer.svelte";

  // The scroll viewport, handed to CommentLayer to scope selection + highlighting.
  let viewportEl = $state<HTMLElement | null>(null);

  // Edge fades are purely positional (not tied to active scrolling): show the top
  // fade whenever there's content scrolled off above, the bottom fade whenever
  // there's more below. A small px threshold avoids a hairline fade at the ends.
  const scrollPx = $derived($scrollCursor.progress * $scrollCursor.max);
  const topFade = $derived(scrollPx > 2);
  const bottomFade = $derived($scrollCursor.max - scrollPx > 2);
</script>

<div class="chat">
  <div class="messages-viewport" use:customScroll bind:this={viewportEl}>
    <div class="messages" data-scroll-inner>
      {#if $hiddenMessageCount > 0}
        <div class="empty">{$hiddenMessageCount} earlier message{$hiddenMessageCount === 1 ? "" : "s"} hidden</div>
      {/if}
      {#each $renderedGroups as g (g.key)}
        {#if g.kind === "tools"}
          <ToolGroup tools={g.tools} />
        {:else}
          <Message m={g.message} />
        {/if}
      {/each}
      {#if $renderedGroups.length === 0}
        <div class="empty">{$selectedWorktree ? "No messages yet." : "No workspace selected."}</div>
      {/if}
      <!-- The live "thinking…" / end-of-turn "Finished in…" line is part of the
           chat transcript, so it scrolls with the messages (not pinned to the input). -->
      <LoadingState />
    </div>
    <!-- Edge fades: messages fade out as they slide past the top/bottom. -->
    <div class="edge-fade edge-fade-top" class:show={topFade}></div>
    <div class="edge-fade edge-fade-bottom" class:show={bottomFade}></div>
    <ScrollIndicator />
  </div>

  <Suggestions />
  <Composer />
  <PermissionModal />
  <QuestionModal />
  <CommentLayer viewport={viewportEl} />
</div>
