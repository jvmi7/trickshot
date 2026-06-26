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

  // Edge fades are purely positional (not tied to active scrolling): show the top
  // fade whenever there's content scrolled off above, the bottom fade whenever
  // there's more below. A small px threshold avoids a hairline fade at the ends.
  $: scrollPx = $scrollCursor.progress * $scrollCursor.max;
  $: topFade = scrollPx > 2;
  $: bottomFade = $scrollCursor.max - scrollPx > 2;
</script>

<div class="chat">
  <div class="messages-viewport" use:customScroll>
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
    </div>
    <!-- Edge fades: messages fade out as they slide past the top/bottom and
         fade in as they enter, tracking the custom scroll. -->
    <div class="edge-fade edge-fade-top" class:show={topFade}></div>
    <div class="edge-fade edge-fade-bottom" class:show={bottomFade}></div>
    <ScrollIndicator />
  </div>

  <LoadingState />
  <Suggestions />
  <Composer />
  <PermissionModal />
  <QuestionModal />
</div>
