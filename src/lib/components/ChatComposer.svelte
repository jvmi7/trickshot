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
  import * as api from "../api";
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

  /** Base64 for the save_attachment wire (btoa chokes on raw bytes > 0x7f,
   *  so build a binary string in bounded chunks first). */
  function toBase64(bytes: Uint8Array): string {
    let bin = "";
    const CHUNK = 0x8000; // fromCharCode's spread has an argument-count limit
    for (let i = 0; i < bytes.length; i += CHUNK)
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(bin);
  }

  /** Pasted FILES (screenshots, images, documents) can't ride a text PTY —
   *  persist each via save_attachment and splice the resulting path into the
   *  draft; the CLI reads files by path. Plain-text pastes keep the browser
   *  default (this handler only claims the event when files are present). */
  async function onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    error = "";
    try {
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const dot = f.name.lastIndexOf(".");
        const ext = dot >= 0 ? f.name.slice(dot + 1) : (f.type.split("/")[1] ?? "png");
        const path = await api.saveAttachment(toBase64(bytes), ext);
        draft = draft === "" || draft.endsWith(" ") ? `${draft}${path} ` : `${draft} ${path} `;
      }
      textareaEl?.focus();
    } catch (err) {
      error = String(err);
    }
  }
</script>

<div class="chat-composer" style="--composer-accent: {accent}">
  {#if error}
    <p class="error-text">{error}</p>
  {/if}
  <!-- Concentric with the terminal card: --app-composer-radius = pane radius
       − the composer's inset (the same recipe that nests the card in the
       window). -->
  <InputGroup.Root class="rounded-[var(--app-composer-radius)]">
    <!-- Body-size type at EVERY width: the base Textarea ships
         `text-base md:text-sm`, so a plain text-base still lost to the
         responsive md: variant on desktop — override that breakpoint too.
         FIXED height (field-sizing-fixed h-16): content scrolls INSIDE the
         box instead of growing it — growth resized the terminal above and
         forced a veiled refit (the "flash") on every wrap. -->
    <InputGroup.Textarea
      bind:ref={textareaEl}
      bind:value={draft}
      rows={1}
      {placeholder}
      class="field-sizing-fixed h-16 text-base md:text-base"
      aria-label="Prompt for Claude"
      onkeydown={onKeydown}
      onpaste={onPaste}
    />
    <!-- self-start: the send/stop button pins to the TOP line (the fixed box
         still scrolls multiline content under it). -->
    <InputGroup.Addon align="inline-end" class="self-start pt-1.5">
      {#if busy}
        <InputGroup.Button
          size="xs"
          variant="default"
          class="rounded-full hover:opacity-90"
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
          class="rounded-full hover:opacity-90"
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
  /* Focus ring in the SESSION's color: the workspace identity accent (the
     swatch/❯/send-button hue) replaces both the resting border and the stock
     shadcn ring while the input owns the keyboard. :global — the slots live
     inside ui/input-group, which never gets hand-edited; the consumer
     restyles its own instance. */
  .chat-composer
    :global(
      [data-slot="input-group"]:has([data-slot="input-group-control"]:focus-visible)
    ) {
    border-color: var(--composer-accent);
    box-shadow: none;
  }
</style>
