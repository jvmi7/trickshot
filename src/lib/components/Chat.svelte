<script lang="ts">
  import {
    renderedMessages,
    hiddenMessageCount,
    selectedWorktree,
    scrollCursor,
  } from "../stores";
  import { customScroll } from "../customScroll";
  import Message from "./Message.svelte";
  import Composer from "./Composer.svelte";
  import PermissionModal from "./PermissionModal.svelte";
  import ScrollIndicator from "./ScrollIndicator.svelte";
  import LoadingState from "./LoadingState.svelte";

  // Bottom fade only while actively scrolling and not yet at the latest message;
  // it fades out smoothly (CSS) once you settle / reach the bottom.
  $: bottomFade = $scrollCursor.active && $scrollCursor.max > 0 && $scrollCursor.progress < 0.985;
</script>

<div class="chat">
  <div class="messages-viewport" use:customScroll>
    <div class="messages" data-scroll-inner>
      {#if $hiddenMessageCount > 0}
        <div class="empty">{$hiddenMessageCount} earlier message{$hiddenMessageCount === 1 ? "" : "s"} hidden</div>
      {/if}
      {#each $renderedMessages as m (m.__key)}
        <Message {m} />
      {/each}
      {#if $renderedMessages.length === 0}
        <div class="empty">{$selectedWorktree ? "No messages yet." : "No workspace selected."}</div>
      {/if}
    </div>
    <!-- Edge fades: messages fade out as they slide past the top/bottom and
         fade in as they enter, tracking the custom scroll. -->
    <div class="edge-fade edge-fade-top"></div>
    <div class="edge-fade edge-fade-bottom" class:show={bottomFade}></div>
    <ScrollIndicator />
  </div>

  <LoadingState />
  <Composer />
  <PermissionModal />
</div>
