<!-- DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
     (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
     "Deprecated GUI surface" before extending. -->
<script lang="ts">
  // Slack-style thread, as a floating Sheet that slides in from the right and
  // overlays the chat WITHOUT reflowing the layout. Feature component (Tier B):
  // couples to stores/api. Open state is driven by $activeCommentId; replies are
  // out-of-band — they stream here via `comment_reply` and NEVER enter the main
  // transcript. Mounted once in App.svelte (the Sheet portals out, so its place in
  // the tree doesn't affect layout).
  import { tick } from "svelte";
  import {
    selectedWorktree,
    activeComments,
    activeCommentId,
    activeMessages,
    submitCommentTurn,
    removeComment,
    closeComment,
    setCommentPending,
  } from "../stores";
  import type { CommentThread } from "../comments";
  import * as api from "../api";
  import * as Sheet from "$lib/components/ui/sheet";
  import Markdown from "./Markdown.svelte";
  import ThinkingIndicator from "./ThinkingIndicator.svelte";
  import { InputGroupTextarea } from "$lib/components/ui/input-group";
  import { Button } from "$lib/components/ui/button";
  import IconButton from "./IconButton.svelte";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import X from "@lucide/svelte/icons/x";

  let text = $state("");
  let scrollEl = $state<HTMLDivElement | null>(null);
  // Root-quote collapse: the anchored message renders as a quote, clamped to a few
  // lines by default with a "Show full message" toggle when it overflows.
  let quoteEl = $state<HTMLElement | null>(null);
  let quoteExpanded = $state(false);
  let quoteOverflows = $state(false);

  const wt = $derived($selectedWorktree);
  const open = $derived(!!$activeCommentId);
  const liveThread = $derived($activeComments.find((t) => t.id === $activeCommentId) ?? null);
  // Keep the last open thread rendered through the Sheet's close animation (the
  // store clears synchronously on close, which would otherwise blank the panel
  // mid-slide-out). While open this tracks the live thread, so streaming still shows.
  let shown = $state<CommentThread | null>(null);
  $effect(() => {
    if (liveThread) shown = liveThread;
  });

  // Collapse the root quote again whenever the OPEN thread changes (by id) — not on
  // every `shown` reassignment (which happens on each streamed delta). Plain `let`
  // so it's an untracked guard, not an effect dependency.
  let quoteThreadId: string | undefined;
  $effect(() => {
    const id = shown?.id;
    if (id !== quoteThreadId) {
      quoteThreadId = id;
      quoteExpanded = false;
    }
  });
  // Does the clamped quote overflow? Measure only while collapsed (when expanded the
  // clientHeight grows to fit, so the comparison would read false and hide the
  // toggle). Re-runs when the root text or collapse state changes.
  $effect(() => {
    void anchoredText;
    const el = quoteEl;
    if (!el || quoteExpanded) return;
    quoteOverflows = el.scrollHeight - el.clientHeight > 4;
  });

  // The anchored agent message — shown IN FULL as the root of the thread (Slack
  // style), not a preview. Read from the live transcript by stable __key (works
  // even if its bubble is unmounted/windowed out).
  const anchored = $derived($activeMessages.find((m) => m.__key === shown?.messageKey) ?? null);
  const anchoredText = $derived(
    anchored && (anchored.type === "assistant" || anchored.type === "user_local")
      ? (anchored.text ?? "")
      : "",
  );
  // Divider label under the root: "N replies", counting the thread's turns.
  const replyCount = $derived(shown?.messages.length ?? 0);
  const replyLabel = $derived(`${replyCount} ${replyCount === 1 ? "reply" : "replies"}`);

  const canSend = $derived(!!wt && !!shown && !shown.pending && text.trim().length > 0);
  const lastMsg = $derived(shown?.messages[shown.messages.length - 1]);
  const awaitingFirstDelta = $derived(!!shown?.pending && lastMsg?.role !== "assistant");

  function send() {
    if (!canSend || !wt || !shown) return;
    const q = text;
    text = "";
    void submitCommentTurn(wt, shown.id, q);
    void tick().then(() => scrollEl?.scrollTo({ top: scrollEl.scrollHeight }));
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) send();
    }
  }

  // Close cleanup runs on ANY close path: the Sheet routes Esc / outside-click /
  // the header X through onOpenChange(false).
  function close() {
    const t = shown;
    if (wt && t) {
      api.cancelComment(wt, t.id);
      // The sidecar aborts silently — it emits NO `done` on cancel (see claude.ts
      // commentTurn) — so reconcile `pending` here, or a turn cancelled mid-stream
      // stays pending forever and reopening hangs on "Thinking…" with a locked input.
      if (t.pending) setCommentPending(wt, t.id, false);
      // Drop a draft that never got a question (an empty thread is just noise).
      if (t.messages.length === 0) removeComment(wt, t.id);
    }
    closeComment();
  }

  // Stream auto-scroll: keep the bottom in view as deltas extend the answer.
  $effect(() => {
    void shown?.messages;
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  });
</script>

<Sheet.Root
  {open}
  onOpenChange={(o) => {
    if (!o) close();
  }}
>
  <!-- Floating/detached look: inset from every edge, fully rounded + bordered with a
       deep shadow so it reads as a card sliding out over the chat (not flush to the
       window). The float/width overrides MUST carry the `data-[side=right]:` prefix —
       the base sheet's right-side utilities are variant-prefixed (higher specificity),
       so plain utilities silently lose to them (that's why it was stuck thin). -->
  <Sheet.Content
    side="right"
    showCloseButton={false}
    class="data-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:h-auto data-[side=right]:sm:max-w-[560px] gap-0 overflow-hidden rounded-2xl border p-0 shadow-2xl"
  >
    <Sheet.Title class="sr-only">Thread</Sheet.Title>
    {#if shown}
      <div class="thread-head">
        <div class="section-label">Thread</div>
        <IconButton onclick={close} title="Close thread" aria-label="Close thread">
          <X />
        </IconButton>
      </div>

      <div class="thread-body" bind:this={scrollEl}>
        <!-- Root: the anchored message that started the thread, as a quote block.
             Clamped to a few lines by default ("Show full message" reveals the rest)
             so the thing being replied to stays compact and clear. -->
        <div class="thread-root">
          {#if anchoredText}
            <blockquote
              bind:this={quoteEl}
              class="thread-quote"
              class:clamped={!quoteExpanded}
              class:faded={!quoteExpanded && quoteOverflows}
            >
              <Markdown text={anchoredText} />
            </blockquote>
            {#if quoteOverflows}
              <button
                type="button"
                class="thread-quote-toggle text-action"
                onclick={() => (quoteExpanded = !quoteExpanded)}
              >
                {quoteExpanded ? "Show less" : "Show full message"}
              </button>
            {/if}
          {:else}
            <blockquote class="thread-quote"><span class="thread-root-empty">(message)</span></blockquote>
          {/if}
        </div>

        <!-- Divider between the root and its replies: a rule, labelled with the reply
             count once there are any. -->
        <div class="thread-divider section-label">
          {#if replyCount > 0}<span>{replyLabel}</span>{/if}
        </div>

        {#each shown.messages as m, i (i)}
          {#if m.role === "user"}
            <div class="thread-msg user">{m.text}</div>
          {:else}
            <div class="thread-msg assistant"><Markdown text={m.text} /></div>
          {/if}
        {/each}
        {#if awaitingFirstDelta}
          <div class="thread-msg assistant">
            <ThinkingIndicator label="Thinking…" startedAt={shown.pendingSince ?? shown.createdAt} />
          </div>
        {/if}
        {#if shown.error}
          <div class="error-text">⚠ {shown.error}</div>
        {/if}
      </div>

      <!-- Reuse the shared chat-composer bubble surface (`.composer-input`, app.css)
           so the thread input matches the main composer exactly: borderless auto-
           growing textarea + a ghost round send button on the same gradient bubble. -->
      <div class="thread-foot">
        <!-- items-center (utilities layer) overrides the shared `.composer-input`
             align-items:flex-start, so the single-line reply input + send button sit
             vertically centered in the bubble (the main composer keeps flex-start). -->
        <div class="composer-input items-center">
          <!-- InputGroupTextarea owns the borderless-textarea recipe (no border/
               ring/bg); only the thread-specific sizing classes remain here. -->
          <InputGroupTextarea
            bind:value={text}
            onkeydown={onKeydown}
            disabled={shown.pending}
            rows={1}
            placeholder={shown.messages.length ? "Reply…" : "Reply in thread…"}
            class="max-h-40 min-h-[2.25rem] flex-1 select-text px-0 py-1.5 text-base"
          />
          <Button
            variant="ghost"
            size="icon"
            class="size-9 shrink-0 rounded-full disabled:text-muted-foreground disabled:opacity-100"
            title="Send"
            aria-label="Send reply"
            onclick={send}
            disabled={!canSend}
          >
            <ArrowUp class="size-5" />
          </Button>
        </div>
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>

<style>
  .thread-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 8px 8px 16px;
    border-bottom: 1px solid var(--app-border);
  }
  .thread-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    overflow-y: auto;
  }
  /* The anchored message at the top of the thread, rendered as a quote block:
     left rule + muted prose, so it reads as "the message you're replying to". */
  .thread-quote {
    position: relative;
    margin: 0;
    border-left: 3px solid var(--app-border);
    padding-left: 12px;
    font-size: var(--text-md);
    line-height: 1.5;
    color: var(--app-dim);
  }
  /* Collapsed: clamp to a few lines; the fade hints there's more below the cut. */
  .thread-quote.clamped {
    max-height: 10.5em;
    overflow: hidden;
  }
  .thread-quote.faded::after {
    content: "";
    position: absolute;
    inset: auto 0 0 0;
    height: 2.6em;
    /* Deliberate shadcn-token read (normally scoped CSS uses --app-*): the fade
       must match the surface it covers, and that surface is the shadcn Sheet
       (bg-popover) this panel renders on — not an --app-* panel tone. */
    background: linear-gradient(to top, var(--popover), transparent);
    pointer-events: none;
  }
  .thread-root-empty {
    color: var(--app-dim);
  }
  /* Chrome/typography come from the composed .text-action (app.css). */
  .thread-quote-toggle {
    margin-top: 4px;
  }
  /* Slack-style divider under the root: a centered reply-count label with a rule
     filling the rest of the row (or just a full-width rule when there are none).
     Label typography comes from the composed .section-label. */
  .thread-divider {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 2px 0 4px;
  }
  .thread-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--app-border);
  }
  .thread-msg {
    font-size: var(--text-md);
    line-height: 1.5;
  }
  .thread-msg.user {
    align-self: flex-end;
    max-width: 90%;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--app-panel-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .thread-msg.assistant {
    align-self: stretch;
  }
  /* Wraps `.composer-input` (which owns its own bubble layout) — just pads it off
     the panel edges, mirroring the main composer's wrapper. No top border: the
     bubble surface provides the visual separation, same as the chat composer. */
  .thread-foot {
    padding: 8px 12px 12px;
  }
</style>