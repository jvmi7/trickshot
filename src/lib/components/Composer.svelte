<script lang="ts">
  import { appendMessage, selectedWorktree, sessionStatus, setStatus } from "../stores";
  import * as api from "../api";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Square from "@lucide/svelte/icons/square";

  let text = "";

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
    text = "";
  }

  function stop() {
    if (!wt) return;
    api.interruptAgent(wt);
    setStatus(wt, "running");
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) send();
    }
  }
</script>

<div class="composer">
  <div class="relative">
    <Textarea
      bind:value={text}
      onkeydown={onKeydown}
      disabled={!alive}
      placeholder={alive ? "Message Claude…  (Enter to send, Shift+Enter for newline)" : "Select a worktree to start"}
      rows={1}
      class="max-h-48 min-h-12 resize-none rounded-full px-4 py-4 pr-14"
    />
    {#if working}
      <Button size="icon" class="absolute right-3 top-1/2 size-9 -translate-y-1/2 rounded-full" title="Stop" aria-label="Stop" onclick={stop}>
        <Square class="size-3.5 fill-current" />
      </Button>
    {:else}
      <Button size="icon" class="absolute right-3 top-1/2 size-9 -translate-y-1/2 rounded-full" title="Send" aria-label="Send" onclick={send} disabled={!canSend}>
        <ArrowUp class="size-4" />
      </Button>
    {/if}
  </div>
</div>
