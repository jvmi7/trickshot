<script lang="ts">
  import { activeMessages, selectedWorktree } from "../stores";
  import Message from "./Message.svelte";
  import Composer from "./Composer.svelte";
  import PermissionModal from "./PermissionModal.svelte";
</script>

<div class="chat">
  <header class="chat-header">
    {#if $selectedWorktree}
      <span class="dim">workspace:</span> <span class="path">{$selectedWorktree}</span>
    {:else}
      <span class="dim">select or create a worktree on the left</span>
    {/if}
  </header>

  <div class="messages">
    {#each $activeMessages as m, i (m.__key ?? i)}
      <Message {m} />
    {/each}
    {#if $activeMessages.length === 0}
      <div class="empty">{$selectedWorktree ? "No messages yet." : "No workspace selected."}</div>
    {/if}
  </div>

  <Composer />
  <PermissionModal />
</div>
