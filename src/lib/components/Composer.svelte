<script lang="ts">
  import {
    appendMessage,
    selectedWorktree,
    sessionStatus,
    setStatus,
    startActivity,
    clearActivity,
    availableCommands,
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
  let textareaEl: HTMLTextAreaElement | null = null;

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
    }, 9);
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
    }, 9);
  }
  onDestroy(() => clearInterval(phTimer));

  // The animated placeholder is rendered as our own overlay (not the native
  // `placeholder` attr) so a blinking caret can ride the END of the backspacing
  // text and settle at the start once it's empty. While that caret shows, the
  // real textarea caret is hidden so there aren't two.
  $: showPhCaret = alive && focused && text === "";

  $: wt = $selectedWorktree;
  $: status = wt ? $sessionStatus[wt] : undefined;
  $: alive = status === "ready" || status === "busy";
  $: working = status === "busy";
  $: canSend = alive && !working && text.trim().length > 0;

  // Slash-command palette: while typing a leading "/<name>" (no space yet), show
  // matching session commands. Resiliently (re-)request the list when missing.
  const requestedCmds = new Set<string>();
  $: if (wt && alive && $availableCommands.length === 0 && !requestedCmds.has(wt)) {
    requestedCmds.add(wt);
    api.requestCommands(wt);
  }
  $: cmdQuery =
    text.startsWith("/") && !text.slice(1).includes(" ") ? text.slice(1).toLowerCase() : null;
  $: cmdMatches =
    cmdQuery !== null
      ? $availableCommands.filter((c) => c.name.toLowerCase().startsWith(cmdQuery)).slice(0, 8)
      : [];
  $: showPalette = focused && cmdMatches.length > 0;

  function pickCommand(name: string) {
    text = `/${name} `;
    textareaEl?.focus();
  }

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

<div class="composer relative">
  {#if showPalette}
    <!-- Slash-command suggestions, floating above the input. mousedown+prevent
         keeps the textarea focused so the click registers before blur hides it. -->
    <div
      class="bg-popover text-popover-foreground absolute bottom-full left-0 z-50 mb-2 max-h-64 w-72 overflow-auto rounded-md border shadow-md"
    >
      {#each cmdMatches as c (c.name)}
        <button
          type="button"
          class="hover:bg-accent flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left"
          on:mousedown|preventDefault={() => pickCommand(c.name)}
        >
          <span class="text-sm font-medium">/{c.name}</span>
          {#if c.description}
            <span class="text-muted-foreground line-clamp-1 text-xs">{c.description}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
  <!-- Two rows: a terminal-style prompt on top — a borderless textarea that blends
       into the footer, with the send button — and the model selector below it. -->
  <div class="mb-2 flex items-start gap-2">
    <!-- pt-2/leading-5 match the textarea's top padding + line-height so the
         caret lines up with the FIRST line as the box grows (not centered). -->
    <span class="composer-caret pt-2 leading-5" class:focused>&gt;</span>
    <!-- The textarea's native placeholder is suppressed; the animated placeholder
         (with its trailing caret) is the overlay below, kept pixel-aligned with
         the textarea's text by matching its padding/leading/size. -->
    <div class="group relative flex-1">
      <Textarea
        bind:value={text}
        bind:ref={textareaEl}
        onkeydown={onKeydown}
        onfocus={onFocus}
        onblur={onBlur}
        disabled={!alive}
        rows={2}
        class="max-h-48 min-h-[3.25rem] w-full resize-none rounded-none border-0 bg-transparent px-0 pt-2 pb-1 shadow-none outline-none transition-colors hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent {showPhCaret ? 'caret-transparent' : 'caret-primary'}"
      />
      {#if text === ""}
        <div
          class="text-muted-foreground group-hover:text-foreground pointer-events-none absolute inset-0 pt-2 text-base whitespace-pre transition-colors select-none md:text-sm"
          aria-hidden="true"
        >{alive ? ph : "Select a worktree to start"}{#if showPhCaret}<span class="ph-caret"></span>{/if}</div>
      {/if}
    </div>
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
