<script lang="ts">
  import {
    activeSessionAlive,
    selectedWorktree,
    sessionStatus,
    setStatus,
    clearActivity,
    availableCommands,
    submitUserTurn,
    enqueueMessage,
    suppressNextDrain,
    requestOnce,
    minimalMode,
    setMinimalMode,
  } from "../stores";
  import { onDestroy } from "svelte";
  import * as api from "../api";
  import { createAnimatedPlaceholder } from "../composerPlaceholder.svelte";
  import { Button } from "$lib/components/ui/button";
  import { InputGroupTextarea } from "$lib/components/ui/input-group";
  import { Switch } from "$lib/components/ui/switch";
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
  // The animation state machine lives in composerPlaceholder.svelte.ts; this
  // component only wires it to the real input's lifecycle.
  const ph = createAnimatedPlaceholder({ placeholder: "Start building...", getEl: () => phEl });
  onDestroy(ph.destroy);

  function onPointerDown(e: PointerEvent) {
    // Active only while the overlay is actually showing the placeholder.
    ph.pointerdown(e, alive && text === "");
  }

  function onFocus() {
    focused = true;
    // Programmatic autofocus keeps the placeholder readable (native-like); it
    // hides on the first keystroke since the overlay only renders while empty.
    if (programmaticFocus) return;
    ph.focus();
  }
  function onBlur() {
    focused = false;
    ph.blur(!text.trim());
  }

  const wt = $derived($selectedWorktree);
  const status = $derived(wt ? $sessionStatus[wt] : undefined);
  const alive = $derived($activeSessionAlive);
  const working = $derived(status === "busy");
  const canSend = $derived(alive && !working && text.trim().length > 0);
  // While the agent is busy, the same field queues a follow-up instead of sending.
  const canQueue = $derived(working && text.trim().length > 0);
  // Autofocus the input once per worktree when its session becomes alive (the
  // onboarding "session ready → just type" moment; also fires on worktree
  // switches). Plain lets — deliberately non-reactive bookkeeping. Guards: never
  // steal focus from another text input (e.g. the sidebar's branch-name field)
  // or while a dialog is open. Runs post-DOM-update, so `disabled` has cleared.
  let autofocusedFor: string | null = null;
  let programmaticFocus = false;
  $effect(() => {
    if (!wt || !alive || autofocusedFor === wt || !textareaEl) return;
    const ae = document.activeElement;
    const typing =
      ae instanceof HTMLElement &&
      (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
    if (typing || document.querySelector('[role="dialog"][data-state="open"]')) return;
    autofocusedFor = wt;
    programmaticFocus = true;
    textareaEl.focus();
    programmaticFocus = false;
  });

  // What the overlay reads while the field is disabled — state-aware so it never
  // instructs the user to do something they've already done (selecting a worktree
  // during the sidecar boot gap) or gives no way out of a dead session.
  const idleLabel = $derived(
    !wt
      ? "Select a worktree to start"
      : status === "starting"
        ? "Waking the agent…"
        : "Session stopped — click the worktree to restart",
  );

  // The animated placeholder is rendered as our own overlay (not the native
  // `placeholder` attr) so a blinking caret can ride the END of the backspacing
  // text and settle at the start once it's empty. While that caret shows, the
  // real textarea caret is hidden so there aren't two.
  const showPhCaret = $derived(alive && focused && text === "");

  // Slash-command palette: while typing a leading "/<name>" (no space yet), show
  // matching session commands. Resiliently (re-)request the list when missing; the
  // instance-scoped `seen` Set lets a remount/session-restart re-request.
  const requestedCmds = new Set<string>();
  $effect(() => {
    if (wt && alive && $availableCommands.length === 0) {
      requestOnce(requestedCmds, wt, "commands", api.requestCommands);
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

  // Keyboard-highlighted palette row; reset to the top whenever the query changes.
  let cmdIndex = $state(0);
  $effect(() => {
    void cmdQuery;
    cmdIndex = 0;
  });

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

  // Queue a follow-up while the agent is busy — it sends when the current turn ends
  // (see maybeDrainQueued). The pill row (QueuedMessages) lets you reorder/send-now.
  function queue() {
    const t = text.trim();
    if (!t || !wt || !working) return;
    enqueueMessage(wt, t);
    text = "";
  }

  function stop() {
    if (!wt) return;
    api.interruptAgent(wt);
    // The interrupt emits a turn_end; tell the drain to skip it so Stop halts
    // cleanly and leaves any queued follow-ups intact (not auto-sent).
    suppressNextDrain(wt);
    setStatus(wt, "ready");
    clearActivity(wt);
  }

  function onKeydown(e: KeyboardEvent) {
    // While the slash palette is open it owns Arrow/Enter/Tab — otherwise Enter
    // would send the partial "/cmd" text as a real turn.
    if (showPalette) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        cmdIndex = (cmdIndex + step + cmdMatches.length) % cmdMatches.length;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const cmd = cmdMatches[cmdIndex] ?? cmdMatches[0];
        if (cmd) pickCommand(cmd.name);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (working) queue();
      else if (canSend) send();
    }
  }
</script>

<div class="composer chat-col relative">
  {#if showPalette}
    <!-- Slash-command suggestions, floating above the input. mousedown+prevent
         keeps the textarea focused so the click registers before blur hides it. -->
    <div
      class="bg-popover text-popover-foreground absolute bottom-full left-0 z-50 mb-2 max-h-64 w-72 overflow-auto rounded-md border shadow-md"
    >
      {#each cmdMatches as c, i (c.name)}
        <button
          type="button"
          class="hover:bg-accent flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left {i === cmdIndex ? 'bg-accent' : ''}"
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
  <div class="composer-input group/input mb-2">
    <!-- The textarea's native placeholder is suppressed; the animated placeholder
         (with its trailing caret) is the overlay below, kept pixel-aligned with
         the textarea's text by matching its padding/leading/size. -->
    <div class="relative flex-1">
      <!-- InputGroupTextarea owns the borderless-textarea recipe (no border/ring/
           bg); only the composer-specific sizing/caret classes remain here. -->
      <InputGroupTextarea
        bind:value={text}
        bind:ref={textareaEl}
        onkeydown={onKeydown}
        onpointerdown={onPointerDown}
        onfocus={onFocus}
        onblur={onBlur}
        disabled={!alive}
        rows={1}
        class="max-h-48 min-h-[2.25rem] w-full select-text px-0 py-1.5 text-base md:text-base group-hover/input:text-foreground {showPhCaret ? 'caret-transparent' : 'caret-foreground'}"
      />
      {#if text === ""}
        <div
          bind:this={phEl}
          class="text-muted-foreground group-hover/input:text-foreground pointer-events-none absolute inset-0 flex items-center text-base whitespace-pre transition-colors select-none"
          aria-hidden="true"
        >{alive ? ph.text : idleLabel}{#if alive && ph.sel}<span class="ph-sel">{ph.sel}</span>{:else if showPhCaret}<span class="ph-caret"></span>{/if}</div>
      {/if}
    </div>
    {#if working}
      <Button variant="ghost" size="icon" class="size-9 shrink-0 rounded-full bg-destructive/20 text-destructive hover:bg-destructive/30 hover:text-destructive" title="Stop" aria-label="Stop" onclick={stop}>
        <Square class="size-3.5 fill-current" />
      </Button>
      <!-- Queue a follow-up while busy: sends when the current turn finishes. -->
      <Button variant="ghost" size="icon" class="size-9 shrink-0 rounded-full disabled:opacity-100 disabled:text-muted-foreground" title="Queue — sends when the agent finishes" aria-label="Queue message" onclick={queue} disabled={!canQueue}>
        <ArrowUp class="size-5" />
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
    <!-- Minimal mode: global view filter — show only one-sentence agent summaries. -->
    <label
      class="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none"
      title="Minimal mode: filter the chat to one-sentence agent summaries"
    >
      <Switch
        checked={$minimalMode}
        onCheckedChange={(v) => setMinimalMode(v)}
        aria-label="Minimal mode"
      />
      Minimal
    </label>
  </div>
</div>
