<script lang="ts">
  import { messages, activeProjectDir } from "../stores";
  import Message from "./Message.svelte";
  import Composer from "./Composer.svelte";
  import PermissionModal from "./PermissionModal.svelte";
</script>

<div class="chat">
  <header class="chat-header">
    {#if $activeProjectDir}
      <span class="dim">session:</span> <span class="path">{$activeProjectDir}</span>
    {:else}
      <span class="dim">no active session — create or start a worktree on the left</span>
    {/if}
  </header>

  <div class="messages">
    {#each $messages as m, i (i)}
      <Message {m} />
    {/each}
    {#if $messages.length === 0}
      <div class="empty">No messages yet.</div>
    {/if}
  </div>

  <Composer />
  <PermissionModal />
</div>
