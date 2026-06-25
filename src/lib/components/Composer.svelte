<script lang="ts">
  import {
    appendMessage,
    selectedWorktree,
    sessionStatus,
    setStatus,
    startActivity,
    clearActivity,
  } from "../stores";
  import { onDestroy } from "svelte";
  import * as api from "../api";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import ModelSelector from "./ModelSelector.svelte";
  import PermissionModeSelector from "./PermissionModeSelector.svelte";
  import CostIndicator from "./CostIndicator.svelte";
  import Square from "@lucide/svelte/icons/square";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";

  let text = "";
  let focused = false;

  // Animated placeholder: "start cooking" deletes itself char-by-char on focus
  // (so the field reads empty when you click in); restored on blur if still empty.
  const PLACEHOLDER = "start cooking";
  let ph = PLACEHOLDER;
  let phTimer: ReturnType<typeof setInterval> | undefined;
  function onFocus() {
    focused = true;
    clearInterval(phTimer);
    phTimer = setInterval(() => {
      ph = ph.slice(0, -1);
      if (!ph) clearInterval(phTimer);
    }, 15);
  }
  function onBlur() {
    focused = false;
    clearInterval(phTimer);
    if (text.trim()) return; // a real message is showing; leave the placeholder hidden
    // type "start cooking" back in, char by char (continues from wherever the
    // delete left off, since `ph` is always a prefix of PLACEHOLDER).
    phTimer = setInterval(() => {
      ph = PLACEHOLDER.slice(0, ph.length + 1);
      if (ph === PLACEHOLDER) clearInterval(phTimer);
    }, 15);
  }
  onDestroy(() => clearInterval(phTimer));

  $: wt = $selectedWorktree;
  $: status = wt ? $sessionStatus[wt] : undefined;
  $: alive = status === "ready" || status === "busy";
  $: working = status === "busy";
  $: canSend = alive && !working && text.trim().length > 0;

  async function send() {
    const t = text.trim();
    if (!t || !wt || working) return;
    // Snapshot the target: send() is async and `wt` is reactive, so the user can
    // switch worktrees during the await. Every read below must refer to the
    // worktree this turn was actually sent to, not the now-selected one.
    const sendWt = wt;
    // Optimistically render the user's own turn; mark the session working until
    // the turn's `result` message arrives (App.svelte flips it back to running).
    appendMessage(sendWt, { type: "user_local", text: t });
    setStatus(sendWt, "busy");
    startActivity(sendWt);
    text = "";
    try {
      await api.sendUserTurn(sendWt, t);
    } catch (e) {
      // The IPC write was rejected (e.g. the session isn't running) — surface it
      // and unstick the UI instead of spinning `busy` on a turn that never landed.
      appendMessage(sendWt, { type: "error", error: `failed to send: ${e}` });
      setStatus(sendWt, "ready");
      clearActivity(sendWt);
    }
  }

  function stop() {
    if (!wt) return;
    api.interruptAgent(wt);
    setStatus(wt, "ready");
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
  <!-- Two rows: a terminal-style prompt on top — a borderless textarea that blends
       into the footer, with the send button — and the model selector below it. -->
  <div class="mb-2 flex items-start gap-2">
    <!-- pt-2/leading-5 match the textarea's top padding + line-height so the
         caret lines up with the FIRST line as the box grows (not centered). -->
    <span class="composer-caret pt-2 leading-5" class:focused>&gt;</span>
    <Textarea
      bind:value={text}
      onkeydown={onKeydown}
      onfocus={onFocus}
      onblur={onBlur}
      disabled={!alive}
      placeholder={alive ? ph : "Select a worktree to start"}
      rows={2}
      class="max-h-48 min-h-[3.25rem] flex-1 resize-none rounded-none border-0 bg-transparent px-0 pt-2 pb-1 caret-primary shadow-none outline-none transition-colors placeholder:transition-colors hover:text-foreground hover:placeholder:text-foreground focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
    />
    {#if working}
      <Button variant="ghost" size="icon" class="size-9 shrink-0 self-center rounded-full" title="Stop" aria-label="Stop" onclick={stop}>
        <Square class="size-3.5 fill-current" />
      </Button>
    {:else}
      <Button variant="ghost" size="icon" class="size-9 shrink-0 self-center rounded-full" title="Send" aria-label="Send" onclick={send} disabled={!canSend}>
        <ArrowUp class="size-5" />
      </Button>
    {/if}
  </div>
  <div class="flex items-center gap-2">
    <PermissionModeSelector />
    <ModelSelector />
    <CostIndicator />
  </div>
</div>
