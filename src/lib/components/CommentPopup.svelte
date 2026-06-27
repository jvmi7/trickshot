<script lang="ts">
  // Notion-style inline-comment thread card. Renders ONE comment thread (the
  // anchored snippet + the out-of-band Q&A) and a mini-composer to ask a follow-up.
  // Feature component (Tier B): couples to stores/api. Positioned `fixed` next to
  // its highlight by the parent CommentLayer, which passes the anchor `rect`.
  import { tick } from "svelte";
  import {
    selectedWorktree,
    submitCommentTurn,
    removeComment,
    closeComment,
  } from "../stores";
  import * as api from "../api";
  import type { CommentThread } from "../comments";
  import Markdown from "./Markdown.svelte";
  import { Textarea } from "$lib/components/ui/textarea";
  import IconButton from "./IconButton.svelte";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import X from "@lucide/svelte/icons/x";

  let { thread, rect }: { thread: CommentThread; rect: DOMRect | null } = $props();

  let text = $state("");
  let cardEl = $state<HTMLDivElement | null>(null);
  let scrollEl = $state<HTMLDivElement | null>(null);

  const wt = $derived($selectedWorktree);
  const canSend = $derived(!!wt && !thread.pending && text.trim().length > 0);
  // Show a "thinking…" row while a turn is in flight and no answer text has landed
  // yet (the streamed answer replaces it as deltas arrive).
  const lastMsg = $derived(thread.messages[thread.messages.length - 1]);
  const awaitingFirstDelta = $derived(thread.pending && lastMsg?.role !== "assistant");

  // Card geometry: anchor below the highlight, clamped into the viewport. Fixed
  // positioning is correct here because getBoundingClientRect already reflects the
  // chat's CSS transform (visual coords), so no manual scroll-offset math is needed.
  const WIDTH = 340;
  const pos = $derived.by(() => {
    if (typeof window === "undefined" || !rect) return { left: 16, top: 64 };
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - WIDTH - 8);
    const top = Math.min(rect.bottom + 8, window.innerHeight - 80);
    return { left, top };
  });

  function send() {
    if (!canSend || !wt) return;
    const q = text;
    text = "";
    void submitCommentTurn(wt, thread.id, q);
    // Keep the latest turn in view as the answer streams in.
    void tick().then(() => scrollEl?.scrollTo({ top: scrollEl.scrollHeight }));
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) send();
    }
  }

  function close() {
    if (wt) {
      api.cancelComment(wt, thread.id);
      // Drop a draft that never got a question (an empty thread is just noise).
      if (thread.messages.length === 0) removeComment(wt, thread.id);
    }
    closeComment();
  }

  // Esc closes; an outside click closes (but a click on another highlight is
  // handled by CommentLayer, which re-opens the other thread).
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  function onWindowPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (cardEl && target && !cardEl.contains(target) && !target.closest("mark.comment-highlight")) {
      close();
    }
  }

  // Stream auto-scroll: keep the bottom in view as deltas extend the answer.
  $effect(() => {
    void thread.messages;
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  });
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerDown} />

<div
  bind:this={cardEl}
  class="comment-popup"
  style="left: {pos.left}px; top: {pos.top}px; width: {WIDTH}px;"
  role="dialog"
  aria-label="Inline comment"
>
  <div class="comment-popup-head">
    <span class="comment-quote" title={thread.selectedText}>“{thread.selectedText}”</span>
    <IconButton onclick={close} title="Close" aria-label="Close comment">
      <X />
    </IconButton>
  </div>

  <div class="comment-popup-body" bind:this={scrollEl}>
    {#if thread.messages.length === 0 && !thread.pending}
      <div class="comment-empty">Ask about the highlighted text. This stays out of the main chat.</div>
    {/if}
    {#each thread.messages as m, i (i)}
      {#if m.role === "user"}
        <div class="comment-msg user">{m.text}</div>
      {:else}
        <div class="comment-msg assistant"><Markdown text={m.text} /></div>
      {/if}
    {/each}
    {#if awaitingFirstDelta}
      <div class="comment-msg assistant comment-thinking">Thinking…</div>
    {/if}
    {#if thread.error}
      <div class="comment-error">⚠ {thread.error}</div>
    {/if}
  </div>

  <div class="comment-popup-foot">
    <Textarea
      bind:value={text}
      onkeydown={onKeydown}
      disabled={thread.pending}
      rows={1}
      placeholder={thread.messages.length ? "Reply…" : "Ask a question…"}
      class="max-h-32 min-h-[2rem] flex-1 resize-none border-0 bg-transparent px-0 py-1 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
    />
    <IconButton onclick={send} disabled={!canSend} title="Send" aria-label="Send comment">
      <ArrowUp />
    </IconButton>
  </div>
</div>

<style>
  .comment-popup {
    position: fixed;
    z-index: 60;
    display: flex;
    flex-direction: column;
    max-height: 60vh;
    border-radius: 12px;
    border: 1px solid var(--app-border, var(--border));
    background: var(--popover);
    color: var(--popover-foreground);
    box-shadow:
      0 10px 30px -10px rgb(0 0 0 / 0.4),
      0 2px 8px -2px rgb(0 0 0 / 0.3);
    overflow: hidden;
  }
  .comment-popup-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 12px;
    border-bottom: 1px solid var(--app-border, var(--border));
  }
  .comment-quote {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--muted-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .comment-popup-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    overflow-y: auto;
  }
  .comment-empty {
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .comment-msg {
    font-size: 13px;
    line-height: 1.5;
  }
  .comment-msg.user {
    align-self: flex-end;
    max-width: 90%;
    padding: 6px 10px;
    border-radius: 10px;
    background: var(--app-panel-2, var(--muted));
    white-space: pre-wrap;
  }
  .comment-msg.assistant {
    align-self: stretch;
  }
  .comment-thinking {
    color: var(--muted-foreground);
  }
  .comment-error {
    font-size: 12px;
    color: var(--destructive);
  }
  .comment-popup-foot {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 6px 8px 8px 12px;
    border-top: 1px solid var(--app-border, var(--border));
  }
</style>
