<script lang="ts">
  // The custom chat input — THE one composer row (textarea + round send):
  // every chat cell docks one under its terminal, and the homepage's
  // HomeComposer wraps the same component with its own delivery. Text reaches
  // the real CLI via sendToCli (bracketed paste + Enter — the ComposeDialog
  // path, busy-mute included); the TUI stays fully interactive above for
  // dialogs, menus, and shortcuts. Deliberate trade (user choice): the TUI
  // input's own interactivity (slash menu, @-completion, ↑-history) doesn't
  // apply while typing HERE — text arrives on submit. Feature component.
  import { tick } from "svelte";
  import {
    chatStatusByKey,
    DEFAULT_CHAT_ID,
    focusedChatByWorktree,
    interruptChat,
    sendToCli,
  } from "../stores";
  import { claudeTermKey } from "../terminal";
  import { profileAccent } from "../termProfiles";
  import * as InputGroup from "$lib/components/ui/input-group";

  let {
    worktree,
    chatId,
    placeholder = "Message Claude… (⇧↩ for a new line)",
    autofocus = false,
    onSend,
  }: {
    worktree: string;
    /** Target chat; omitted = the worktree's focused chat. */
    chatId?: string;
    placeholder?: string;
    /** Grab the keyboard on mount / when flipped true (ONE cell at a time —
     *  the caller gates this on being the focused chat). */
    autofocus?: boolean;
    /** Override delivery (HomeComposer activates the worktree first). The
     *  default sends straight to this chat's CLI. */
    onSend?: (text: string) => Promise<void>;
  } = $props();

  let draft = $state("");
  let sending = $state(false);
  let error = $state("");
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  /** Give the composer the keyboard (the cell's click-anywhere target). */
  export function focusInput() {
    textareaEl?.focus();
  }

  const canSend = $derived(!sending && draft.trim().length > 0);
  // The button wears the WINDOW's theme — the workspace identity accent (the
  // swatch/header ❯ color, the same family as the monochrome terminal).
  // SEND is an outline (accent border + accent text, quiet until it matters);
  // STOP is the filled urgent state (accent fill, dark same-hue label).
  // Dynamic values, inline.
  const accent = $derived(profileAccent(worktree));
  const sendStyle = $derived(
    `background-color: transparent; border: 1px solid ${accent}; color: ${accent}`,
  );
  const stopStyle = $derived(
    `background-color: ${accent}; color: color-mix(in oklch, ${accent} 22%, black)`,
  );
  // While THIS chat runs a turn, the send button becomes INTERRUPT (Enter
  // still sends — the TUI queues typed input during a turn).
  const busy = $derived(
    $chatStatusByKey[
      claudeTermKey(worktree, chatId ?? $focusedChatByWorktree[worktree] ?? DEFAULT_CHAT_ID)
    ] === "busy",
  );

  function interrupt() {
    interruptChat(worktree, chatId).catch((e) => (error = String(e)));
  }

  $effect(() => {
    if (autofocus) void tick().then(() => textareaEl?.focus());
  });

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    sending = true;
    error = "";
    try {
      if (onSend) await onSend(text);
      else await sendToCli(worktree, text, true, chatId);
      draft = "";
      textareaEl?.focus(); // stay ready for the next message
    } catch (e) {
      // Delivery failed — keep the draft so nothing is lost.
      error = String(e);
    } finally {
      sending = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }
</script>

<div class="chat-composer">
  {#if error}
    <p class="error-text">{error}</p>
  {/if}
  <!-- rounded-none: the input box is deliberately SQUARE (terminal-crisp,
       squarer than the radius ladder's floor). -->
  <InputGroup.Root class="rounded-none">
    <!-- text-base: the input reads at the app's body size (the primitive's
         stock text-sm sat smaller than everything around it). -->
    <InputGroup.Textarea
      bind:ref={textareaEl}
      bind:value={draft}
      rows={1}
      {placeholder}
      class="text-base"
      aria-label="Prompt for Claude"
      onkeydown={onKeydown}
    />
    <!-- self-start: the send/stop button pins to the TOP line as the
         textarea grows multiline (centering made it float mid-message). -->
    <InputGroup.Addon align="inline-end" class="self-start pt-1.5">
      {#if busy}
        <InputGroup.Button
          size="xs"
          variant="default"
          class="rounded-none hover:opacity-90"
          style={stopStyle}
          title="Stop the running turn (Esc)"
          onclick={interrupt}
        >
          stop
        </InputGroup.Button>
      {:else}
        <InputGroup.Button
          size="xs"
          variant="default"
          class="rounded-none hover:opacity-90"
          style={sendStyle}
          disabled={!canSend}
          onclick={() => void submit()}
        >
          send
        </InputGroup.Button>
      {/if}
    </InputGroup.Addon>
  </InputGroup.Root>
</div>

<style>
  /* The row is chrome-light on purpose — the surrounding surface (cell foot,
     Home card) owns spacing; this owns only its own stack. */
  .chat-composer {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  /* NO focus chrome on the input: the border keeps its RESTING color and
     the stock ring is suppressed — the caret is the focus signal (user
     call; the shadcn border-ring/ring-3 focus treatment read as a darker
     border here). :global — the slots live inside ui/input-group, which
     never gets hand-edited; the consumer restyles its own instance. */
  .chat-composer
    :global(
      [data-slot="input-group"]:has([data-slot="input-group-control"]:focus-visible)
    ) {
    border-color: var(--input);
    box-shadow: none;
  }
</style>
