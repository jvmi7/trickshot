<script lang="ts">
  import {
    selectedWorktree,
    sessionStatus,
    setStatus,
    clearActivity,
    availableCommands,
    submitUserTurn,
    requestOnce,
  } from "../stores";
  import { onDestroy } from "svelte";
  import * as api from "../api";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import ModelSelector from "./ModelSelector.svelte";
  import PermissionModeSelector from "./PermissionModeSelector.svelte";
  import UsageIndicator from "./UsageIndicator.svelte";
  import Square from "@lucide/svelte/icons/square";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";

  let text = $state("");
  let focused = $state(false);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  let phEl = $state<HTMLDivElement | null>(null);

  // Animated placeholder: "Start building..." deletes itself char-by-char on focus
  // (so the field reads empty when you click in); restored on blur if still empty.
  const PLACEHOLDER = "Start building...";
  // How long the highlighted chunk stays selected before it's deleted — brief, so
  // the highlight registers without a noticeable pause before the backspace.
  const HIGHLIGHT_MS = 95;
  let ph = $state(PLACEHOLDER); // visible (left) placeholder text, backspaced char-by-char
  let phSel = $state(""); // the highlighted right-hand chunk (shown, then deleted in one go)
  let phTimer: ReturnType<typeof setInterval> | undefined; // backspace / type-back loop
  let phSelTimer: ReturnType<typeof setTimeout> | undefined; // delay before deleting phSel

  function clearPhTimers() {
    clearInterval(phTimer);
    clearTimeout(phSelTimer);
  }

  // Char-by-char backspace of the (left) placeholder text.
  function backspacePlaceholder() {
    clearInterval(phTimer);
    phTimer = setInterval(() => {
      ph = ph.slice(0, -1);
      if (!ph) clearInterval(phTimer);
    }, 9);
  }

  // Map a click's x to the nearest character boundary in the rendered placeholder
  // (measured per-glyph so it's correct for any font/variable widths).
  function placeholderIndexAt(clientX: number): number {
    const node = phEl?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return PLACEHOLDER.length;
    const len = (node as Text).length;
    const range = document.createRange();
    for (let i = 0; i < len; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return len;
  }

  // Clicking into the (full) placeholder mimics select-to-end → delete → backspace:
  // the text RIGHT of the click is highlighted (theme selection style), held briefly,
  // deleted as one chunk, then the left part backspaces. Fires before focus, so
  // onFocus defers to this sequence.
  function onPointerDown(e: PointerEvent) {
    if (!alive || text !== "" || ph !== PLACEHOLDER || phSel) return;
    const i = placeholderIndexAt(e.clientX);
    if (i >= PLACEHOLDER.length) return; // clicked at/after the end → onFocus full-backspaces
    clearPhTimers();
    ph = PLACEHOLDER.slice(0, i);
    phSel = PLACEHOLDER.slice(i);
    phSelTimer = setTimeout(() => {
      phSel = ""; // delete the highlighted chunk in one go
      backspacePlaceholder(); // then backspace the rest from the cursor
    }, HIGHLIGHT_MS);
  }

  function onFocus() {
    focused = true;
    // A click already kicked off the highlight-then-delete sequence — let it run.
    if (phSel) return;
    backspacePlaceholder();
  }
  function onBlur() {
    focused = false;
    clearPhTimers();
    phSel = "";
    if (text.trim()) return; // a real message is showing; leave the placeholder hidden
    // type "Start building..." back in, char by char (continues from wherever the
    // delete left off, since `ph` is always a prefix of PLACEHOLDER).
    phTimer = setInterval(() => {
      ph = PLACEHOLDER.slice(0, ph.length + 1);
      if (ph === PLACEHOLDER) clearInterval(phTimer);
    }, 9);
  }
  onDestroy(clearPhTimers);

  const wt = $derived($selectedWorktree);
  const status = $derived(wt ? $sessionStatus[wt] : undefined);
  const alive = $derived(status === "ready" || status === "busy");
  const working = $derived(status === "busy");
  const canSend = $derived(alive && !working && text.trim().length > 0);

  // The animated placeholder is rendered as our own overlay (not the native
  // `placeholder` attr) so a blinking caret can ride the END of the backspacing
  // text and settle at the start once it's empty. While that caret shows, the
  // real textarea caret is hidden so there aren't two.
  const showPhCaret = $derived(alive && focused && text === "");

  // Slash-command palette: while typing a leading "/<name>" (no space yet), show
  // matching session commands. Resiliently (re-)request the list when missing.
  $effect(() => {
    if (wt && alive && $availableCommands.length === 0) {
      requestOnce(wt, "commands", api.requestCommands);
    }
  });
  const cmdQuery = $derived(
    text.startsWith("/") && !text.slice(1).includes(" ") ? text.slice(1).toLowerCase() : null,
  );
  const cmdMatches = $derived(
    cmdQuery !== null
      ? $availableCommands.filter((c) => c.name.toLowerCase().startsWith(cmdQuery)).slice(0, 8)
      : [],
  );
  const showPalette = $derived(focused && cmdMatches.length > 0);

  function pickCommand(name: string) {
    text = `/${name} `;
    textareaEl?.focus();
  }

  function send() {
    const t = text.trim();
    if (!t || !wt || working) return;
    text = "";
    // submitUserTurn does the optimistic bubble + status + IPC + error handling
    // (shared with the suggestion chips, so the flow stays identical).
    void submitUserTurn(wt, t);
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
          onmousedown={(e) => {
            e.preventDefault();
            pickCommand(c.name);
          }}
        >
          <span class="text-sm font-medium">/{c.name}</span>
          {#if c.description}
            <span class="text-muted-foreground line-clamp-1 text-xs">{c.description}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
  <!-- The input area: a bubble-styled surface (matches the chat bubbles) holding a
       borderless textarea + the send button. The selector row sits below it. -->
  <div class="composer-input mb-2">
    <!-- The textarea's native placeholder is suppressed; the animated placeholder
         (with its trailing caret) is the overlay below, kept pixel-aligned with
         the textarea's text by matching its padding/leading/size. -->
    <div class="group relative flex-1">
      <Textarea
        bind:value={text}
        bind:ref={textareaEl}
        onkeydown={onKeydown}
        onpointerdown={onPointerDown}
        onfocus={onFocus}
        onblur={onBlur}
        disabled={!alive}
        rows={1}
        class="max-h-48 min-h-[2.25rem] w-full resize-none select-text rounded-none border-0 bg-transparent px-0 py-1.5 text-base md:text-base shadow-none outline-none transition-colors hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent {showPhCaret ? 'caret-transparent' : 'caret-foreground'}"
      />
      {#if text === ""}
        <div
          bind:this={phEl}
          class="text-muted-foreground group-hover:text-foreground pointer-events-none absolute inset-0 flex items-center text-base whitespace-pre transition-colors select-none"
          aria-hidden="true"
        >{alive ? ph : "Select a worktree to start"}{#if alive && phSel}<span class="ph-sel">{phSel}</span>{:else if showPhCaret}<span class="ph-caret"></span>{/if}</div>
      {/if}
    </div>
    {#if working}
      <Button variant="ghost" size="icon" class="size-9 shrink-0 rounded-full bg-destructive/20 text-destructive hover:bg-destructive/30 hover:text-destructive" title="Stop" aria-label="Stop" onclick={stop}>
        <Square class="size-3.5 fill-current" />
      </Button>
    {:else}
      <!-- Grey the disabled state via COLOR (full opacity), not opacity — fading a
           thin SVG's opacity makes its strokes render lighter/thinner (looks like a
           bold/position shift); a color swap keeps the stroke rendering identical. -->
      <Button variant="ghost" size="icon" class="size-9 shrink-0 rounded-full disabled:opacity-100 disabled:text-muted-foreground" title="Send" aria-label="Send" onclick={send} disabled={!canSend}>
        <ArrowUp class="size-5" />
      </Button>
    {/if}
  </div>
  <div class="flex items-center gap-2">
    <PermissionModeSelector />
    <ModelSelector />
    <UsageIndicator />
  </div>
</div>
