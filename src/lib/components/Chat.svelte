<script lang="ts">
  import {
    renderedGroups,
    hiddenMessageCount,
    selectedWorktree,
    scrollCursor,
    minimalMode,
    activeComments,
    openThreadFor,
    authState,
    refreshAuth,
  } from "../stores";
  import { Button } from "$lib/components/ui/button";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import { splitSummary } from "../minimal";
  import { customScroll } from "../customScroll";
  import Message from "./Message.svelte";
  import ToolGroup from "./ToolGroup.svelte";
  import Composer from "./Composer.svelte";
  import Suggestions from "./Suggestions.svelte";
  import PermissionModal from "./PermissionModal.svelte";
  import QuestionModal from "./QuestionModal.svelte";
  import ScrollIndicator from "./ScrollIndicator.svelte";
  import LoadingState from "./LoadingState.svelte";
  import QueuedMessages from "./QueuedMessages.svelte";
  import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";

  const wt = $derived($selectedWorktree);
  // messageKey → number of thread replies, for the per-message "N replies" pill.
  const replyCounts = $derived.by(() => {
    const map = new Map<number, number>();
    for (const t of $activeComments) map.set(t.messageKey, t.messages.length);
    return map;
  });
  // Open (or create) the thread anchored to an agent message. Passed to Message as
  // a handler so Message stays a store-free primitive.
  function replyInThread(messageKey: number | undefined) {
    if (wt && messageKey !== undefined) openThreadFor(wt, messageKey);
  }

  // Floating "Reply" affordance: a SINGLE button tracked to the agent message under
  // the cursor, clamped inside the viewport — so it's reachable even on a message
  // taller than the window (where a bottom-anchored action would be off-screen).
  // `position: sticky` can't do this: the chat uses a custom transform scroll
  // (customScroll.ts) with no native scroll offset for sticky to key off.
  let viewportEl = $state<HTMLDivElement | null>(null);
  let hoverKey = $state<number | null>(null);
  let hoverTop = $state(0); // viewport-relative top (px) for the floating button
  let hoverRight = $state(8); // viewport-relative right offset (px), aligned to the message
  let overButton = $state(false);
  const FLOAT_H = 26; // approx button height, for vertical clamping
  const PAD = 8;
  const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  function trackReply(e: PointerEvent) {
    // While the cursor is on the button itself, hold state so it stays clickable
    // (guard both the overButton flag and the target, since a pointermove can land
    // on the button before its pointerenter fires — without this it would unmount
    // mid-approach and swallow the click).
    const t = e.target as HTMLElement | null;
    if (overButton || t?.closest(".floating-reply")) return;
    const el = t?.closest<HTMLElement>(".msg.assistant[data-threadable]");
    if (!el || !viewportEl) {
      hoverKey = null;
      return;
    }
    const key = Number(el.dataset.msgKey);
    hoverKey = Number.isFinite(key) ? key : null;
    const vp = viewportEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    hoverTop = clampN(e.clientY - vp.top - FLOAT_H / 2, PAD, vp.height - FLOAT_H - PAD);
    hoverRight = clampN(vp.right - r.right, PAD, vp.width - 80);
  }
  const hoverHasReplies = $derived(hoverKey != null && (replyCounts.get(hoverKey) ?? 0) > 0);

  // Attach the hover tracking via addEventListener (a `use:` action, like
  // customScroll) rather than Svelte `onpointermove` attributes — keeps the
  // scroll container free of a static-element a11y warning without a fake ARIA role.
  function replyHover(node: HTMLElement) {
    const onLeave = () => {
      if (!overButton) hoverKey = null;
    };
    node.addEventListener("pointermove", trackReply);
    node.addEventListener("pointerleave", onLeave);
    return {
      destroy() {
        node.removeEventListener("pointermove", trackReply);
        node.removeEventListener("pointerleave", onLeave);
      },
    };
  }

  // Edge fades are purely positional (not tied to active scrolling): show the top
  // fade whenever there's content scrolled off above, the bottom fade whenever
  // there's more below. A small px threshold avoids a hairline fade at the ends.
  const scrollPx = $derived($scrollCursor.progress * $scrollCursor.max);
  const topFade = $derived(scrollPx > 2);
  const bottomFade = $derived($scrollCursor.max - scrollPx > 2);

  // Minimal view: just the user's messages + the agent's one-sentence summaries
  // (assistant turns that carry a parsed summary). Tool groups, system notices,
  // and the full prose are filtered out. Errors still surface.
  const minimalItems = $derived(
    $renderedGroups
      .flatMap((g) => (g.kind === "single" ? [g.message] : []))
      .filter(
        (m) =>
          m.type === "user_local" ||
          m.type === "error" ||
          (m.type === "assistant" && splitSummary(m.text ?? "").bubbles.length > 0),
      ),
  );
</script>

<div class="chat">
  <div class="messages-viewport" use:customScroll use:replyHover bind:this={viewportEl}>
    <div class="messages" class:minimal={$minimalMode} data-scroll-inner>
      {#if $hiddenMessageCount > 0}
        <div class="empty">{$hiddenMessageCount} earlier message{$hiddenMessageCount === 1 ? "" : "s"} hidden</div>
      {/if}
      {#if $minimalMode}
        {#each minimalItems as m (m.__key)}
          <Message {m} minimal />
        {/each}
        {#if minimalItems.length === 0}
          <div class="empty">{$selectedWorktree ? "No quick replies yet." : "No workspace selected."}</div>
        {/if}
      {:else}
        {#each $renderedGroups as g (g.key)}
          {#if g.kind === "tools"}
            <ToolGroup tools={g.tools} />
          {:else}
            <Message
              m={g.message}
              replyCount={replyCounts.get(g.message.__key ?? -1) ?? 0}
              onReplyInThread={() => replyInThread(g.message.__key)}
            />
          {/if}
        {/each}
        {#if $renderedGroups.length === 0}
          <div class="empty">{$selectedWorktree ? "No messages yet." : "No workspace selected."}</div>
        {/if}
      {/if}
      <!-- The live "thinking…" / end-of-turn "Finished in…" line is part of the
           chat transcript, so it scrolls with the messages (not pinned to the input). -->
      <LoadingState />
    </div>
    <!-- Edge fades: messages fade out as they slide past the top/bottom. -->
    <div class="edge-fade edge-fade-top" class:show={topFade}></div>
    <div class="edge-fade edge-fade-bottom" class:show={bottomFade}></div>
    {#if hoverKey != null && !$minimalMode}
      <button
        type="button"
        class="floating-reply"
        style:top="{hoverTop}px"
        style:right="{hoverRight}px"
        title={hoverHasReplies ? "Open thread" : "Reply in thread"}
        onpointerenter={() => (overButton = true)}
        onpointerleave={() => {
          overButton = false;
          hoverKey = null;
        }}
        onclick={() => replyInThread(hoverKey ?? undefined)}
      >
        <MessageSquarePlus class="size-3.5" />
        {hoverHasReplies ? "Open thread" : "Reply"}
      </button>
    {/if}
    <ScrollIndicator />
  </div>

  <Suggestions />
  {#if $authState === "missing"}
    <!-- Ambient sign-in notice (same copy + retry shape as Welcome's): shown when
         the login is definitively absent so the auth wall never lands as a surprise. -->
    <div class="auth-banner">
      <div class="bg-destructive/10 text-destructive flex items-center gap-2 rounded-md px-3 py-2 text-xs">
        <TriangleAlert class="size-3.5 shrink-0" />
        <span>
          trickshot uses your Claude Code login — run <code>claude</code> in a terminal to sign in
        </span>
        <Button
          variant="ghost"
          size="xs"
          class="text-destructive hover:text-destructive ml-auto shrink-0 gap-1"
          onclick={() => void refreshAuth()}
        >
          <RotateCw class="size-3" /> retry
        </Button>
      </div>
    </div>
  {/if}
  <QueuedMessages />
  <Composer />
  <PermissionModal />
  <QuestionModal />
</div>

<style>
  /* Floating "Reply" affordance (see Chat.svelte script): absolutely positioned
     within .messages-viewport, tracked to the hovered agent message and clamped
     into the viewport. Solid background since it overlays message text. Above the
     edge fades (z-index 3) so it stays clickable at the viewport edges. */
  .floating-reply {
    position: absolute;
    z-index: 4;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid var(--app-border, var(--border));
    background: var(--app-panel, var(--muted));
    color: var(--app-dim, var(--muted-foreground));
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.18);
    transition: color 0.12s ease, background 0.12s ease;
  }
  .floating-reply:hover {
    color: var(--app-text, var(--foreground));
    background: var(--app-panel-2, var(--accent));
  }

  /* Sign-in banner: rides the same centered reading column as the composer. */
  .auth-banner {
    width: 100%;
    max-width: var(--chat-col);
    margin-inline: auto;
    flex-shrink: 0;
    padding: 0 32px 8px;
  }
  .auth-banner code {
    background: var(--app-code-bg);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 11px;
  }
</style>
