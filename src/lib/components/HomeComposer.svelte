<script lang="ts">
  // The homepage's "Ask Claude" composer — a fully CUSTOM input whose text
  // reaches the real CLI on submit via sendToCli (bracketed paste + Enter,
  // the ComposeDialog path), so the visuals are entirely ours while the chat
  // stays the untouched TUI. Submit activates the worktree, so the response
  // streams in the full chat pane. Deliberate trade (user choice): the TUI
  // input's own interactivity (slash-command menu, @-file completion,
  // ↑-history) lives in the CLI and doesn't apply while typing HERE — text
  // arrives when submitted. Feature component (stores + session).
  import { activateWorktree, sendToCli } from "../stores";
  import { profileAccent } from "../termProfiles";
  import { basename } from "$lib/utils";
  import * as InputGroup from "$lib/components/ui/input-group";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";

  let { worktree }: { worktree: string } = $props();

  let draft = $state("");
  let sending = $state(false);
  let error = $state("");
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  const canSend = $derived(!sending && draft.trim().length > 0);

  // Focus the input on mount — Home's primary affordance, type right away.
  $effect(() => {
    textareaEl?.focus();
  });

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    sending = true;
    error = "";
    try {
      // Activate FIRST so the user watches the real TUI come up (cold boots
      // take a beat); the paste lands in the now-visible chat.
      await activateWorktree(worktree);
      await sendToCli(worktree, text);
      draft = "";
    } catch (e) {
      // Delivery failed — stay on Home with the draft intact.
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

<div class="composer">
  <div class="composer-head">
    <span class="composer-title">Ask Claude</span>
    <span class="composer-target" title={worktree}>
      <span class="shrink-0" style="color: {profileAccent(worktree)}">
        <GitBranch class="size-3" />
      </span>
      {basename(worktree)}
    </span>
  </div>
  {#if error}
    <p class="error-text">{error}</p>
  {/if}
  <InputGroup.Root class="rounded-xl">
    <InputGroup.Textarea
      bind:ref={textareaEl}
      bind:value={draft}
      rows={2}
      placeholder="Start a task in {basename(worktree)}… (⇧↩ for a new line)"
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
  <p class="composer-hint">↵ sends and opens the chat · full history lives there</p>
</div>

<style>
  /* One-component structural CSS (split-by-reach); colors from the tokens. */
  .composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: min(680px, 100%);
    margin: 0 auto;
  }
  .composer-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .composer-title {
    font-size: var(--text-md);
    font-weight: 600;
  }
  .composer-target {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  .composer-hint {
    font-size: var(--text-2xs);
    color: var(--app-dim);
    text-align: center;
  }
</style>
