<script lang="ts">
  import {
    appendMessage,
    selectedWorktree,
    sessionStatus,
    setStatus,
    startActivity,
    clearActivity,
  } from "../stores";
  import * as api from "../api";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import ModelSelector from "./ModelSelector.svelte";

  let text = "";
  let focused = false;

  $: wt = $selectedWorktree;
  $: status = wt ? $sessionStatus[wt] : undefined;
  $: alive = status === "running" || status === "working";
  $: working = status === "working";
  $: canSend = alive && !working && text.trim().length > 0;

  function send() {
    const t = text.trim();
    if (!t || !wt || working) return;
    // Optimistically render the user's own turn; mark the session working until
    // the turn's `result` message arrives (App.svelte flips it back to running).
    appendMessage(wt, { type: "user_local", text: t });
    api.sendUserTurn(wt, t);
    setStatus(wt, "working");
    startActivity(wt);
    text = "";
  }

  function stop() {
    if (!wt) return;
    api.interruptAgent(wt);
    setStatus(wt, "running");
    clearActivity(wt);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) send();
    }
  }
</script>

<div class="composer">
  <!-- Terminal-style prompt: a borderless textarea that blends into the footer,
       with the model selector tucked just left of the send button. -->
  <div class="flex items-center gap-2">
    <span class="composer-caret" class:focused>&gt;</span>
    <Textarea
      bind:value={text}
      onkeydown={onKeydown}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      disabled={!alive}
      placeholder={alive ? "Message Claude…  (Enter to send, Shift+Enter for newline)" : "Select a worktree to start"}
      rows={1}
      class="max-h-48 min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-0 pt-2 pb-1 shadow-none outline-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
    />
    <ModelSelector />
    {#if working}
      <Button size="icon" class="size-9 shrink-0 rounded-full" title="Stop" aria-label="Stop" onclick={stop}>
        <i class="lni lni-pause text-base leading-none"></i>
      </Button>
    {:else}
      <Button size="icon" class="size-9 shrink-0 rounded-full" title="Send" aria-label="Send" onclick={send} disabled={!canSend}>
        <i class="lni lni-arrow-upward text-lg leading-none"></i>
      </Button>
    {/if}
  </div>
</div>
