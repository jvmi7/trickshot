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
  import { sendToCli } from "../stores";
  import { profileAccent } from "../termProfiles";
  import * as InputGroup from "$lib/components/ui/input-group";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";

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
  // The focus treatment carries the WINDOW's identity: the workspace accent
  // (the swatch/header ❯ color), applied via the scoped override below.
  const accent = $derived(profileAccent(worktree));

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

<div class="chat-composer" style="--composer-accent: {accent}">
  {#if error}
    <p class="error-text">{error}</p>
  {/if}
  <!-- rounded-none: the input box is deliberately SQUARE (terminal-crisp,
       squarer than the radius ladder's floor). -->
  <InputGroup.Root class="rounded-none">
    <InputGroup.Textarea
      bind:ref={textareaEl}
      bind:value={draft}
      rows={1}
      {placeholder}
      aria-label="Prompt for Claude"
      onkeydown={onKeydown}
    />
    <InputGroup.Addon align="inline-end">
      <InputGroup.Button
        size="icon-xs"
        variant="default"
        class="rounded-full"
        aria-label="Send"
        disabled={!canSend}
        onclick={() => void submit()}
      >
        <ArrowUp class="size-3.5" />
      </InputGroup.Button>
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
  /* Focused input = the WORKSPACE's color, not the theme ring: border +
     a soft halo mixed from the identity accent (--composer-accent, set
     inline above). :global — the slots live inside ui/input-group, which
     never gets hand-edited; the consumer restyles its own instance (the
     UsageIndicator badge precedent). */
  .chat-composer
    :global(
      [data-slot="input-group"]:has([data-slot="input-group-control"]:focus-visible)
    ) {
    border-color: var(--composer-accent);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--composer-accent) 25%, transparent);
  }
</style>
