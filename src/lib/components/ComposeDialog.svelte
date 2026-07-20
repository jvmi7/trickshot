<script lang="ts">
  // ⌘E compose popup: a full editor for long / multi-line prompts — the TUI's
  // inline input is cramped for real prompt-writing. The text reaches the CLI
  // via bracketed paste (session.ts › sendToCli): "Send" submits the turn,
  // "Insert" drops it into the TUI's input for further editing there. The
  // draft survives close-without-send (composeDraft, session-scoped).
  // Feature component (reads stores + session orchestration).
  import { tick } from "svelte";
  import {
    composeDraft,
    composeOpen,
    selectedWorktree,
    sendToCli,
    setComposeDraft,
    setComposeOpen,
  } from "../stores";
  import { getTerminal, claudeTermKey } from "../terminal";
  import { toastError } from "../toast";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Dialog from "$lib/components/ui/dialog";
  import Send from "@lucide/svelte/icons/send";
  import TextCursorInput from "@lucide/svelte/icons/text-cursor-input";

  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  // Focus the editor when the popup opens (after the dialog portal mounts).
  $effect(() => {
    if ($composeOpen) void tick().then(() => textareaEl?.focus());
  });

  async function deliver(submit: boolean) {
    const wt = $selectedWorktree;
    const text = $composeDraft.trim();
    if (!wt || !text) return;
    setComposeOpen(false);
    try {
      await sendToCli(wt, text, submit);
      setComposeDraft("");
      getTerminal(claudeTermKey(wt)).term.focus();
    } catch (e) {
      // Delivery failed — reopen with the draft intact so nothing is lost.
      toastError(String(e));
      setComposeOpen(true);
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void deliver(true);
    }
  }
</script>

<Dialog.Root open={$composeOpen} onOpenChange={setComposeOpen}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Compose</Dialog.Title>
      <Dialog.Description>
        Write the prompt here, send it to the agent — or insert it into the terminal's input to
        finish it there.
      </Dialog.Description>
    </Dialog.Header>
    <Textarea
      bind:ref={textareaEl}
      bind:value={$composeDraft}
      rows={14}
      placeholder="Write your prompt… (⌘↩ to send)"
      class="resize-none font-mono text-sm"
      aria-label="Prompt editor"
      onkeydown={onKeydown}
    />
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => setComposeOpen(false)}>Cancel</Button>
      <Button
        variant="outline"
        title="Paste into the TUI's input without submitting"
        disabled={!$composeDraft.trim() || !$selectedWorktree}
        onclick={() => void deliver(false)}
      >
        <TextCursorInput class="size-3.5" /> Insert
      </Button>
      <Button
        title="Send as the next turn (⌘↩)"
        disabled={!$composeDraft.trim() || !$selectedWorktree}
        onclick={() => void deliver(true)}
      >
        <Send class="size-3.5" /> Send
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
