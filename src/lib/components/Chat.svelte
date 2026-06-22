<script lang="ts">
  import { activeMessages, selectedWorktree, scrollCursor } from "../stores";
  import { customScroll } from "../customScroll";
  import Message from "./Message.svelte";
  import Composer from "./Composer.svelte";
  import PermissionModal from "./PermissionModal.svelte";
  import ScrollIndicator from "./ScrollIndicator.svelte";

  // Bottom fade only while actively scrolling and not yet at the latest message;
  // it fades out smoothly (CSS) once you settle / reach the bottom.
  $: bottomFade = $scrollCursor.active && $scrollCursor.max > 0 && $scrollCursor.progress < 0.985;
</script>

<div class="chat">
  <header class="chat-header">
    {#if $selectedWorktree}
      <span class="dim">workspace:</span> <span class="path">{$selectedWorktree}</span>
    {:else}
      <span class="dim">select or create a worktree on the left</span>
    {/if}
  </header>

  <div class="messages-viewport" use:customScroll>
    <div class="messages" data-scroll-inner>
      {#each $activeMessages as m, i (m.__key ?? i)}
        <Message {m} />
      {/each}
      {#if $activeMessages.length === 0}
        <div class="empty">{$selectedWorktree ? "No messages yet." : "No workspace selected."}</div>
      {/if}
    </div>
    <!-- Edge fades: messages fade out as they slide past the top/bottom and
         fade in as they enter, tracking the custom scroll. -->
    <div class="edge-fade edge-fade-top"></div>
    <div class="edge-fade edge-fade-bottom" class:show={bottomFade}></div>
    <ScrollIndicator />
  </div>

  <Composer />
  <PermissionModal />
</div>
