<script lang="ts">
  import type { TranscriptMessage } from "../types";
  import { splitSummary } from "../minimal";
  import Markdown from "./Markdown.svelte";
  import MessageSquare from "@lucide/svelte/icons/message-square";

  // Renders ONE non-tool transcript entry: assistant prose, a session notice, or
  // the UI-only user_local / error bubbles. Branch on `type`; unknown renders
  // nothing. Tool calls are NOT handled here — they're batched into ToolGroup (see
  // renderedGroups / Chat.svelte); tool_result is folded into its call.
  // `minimal`: in minimal mode, an assistant bubble shows ONLY its one-sentence
  // summary (Chat filters which messages reach here); the summary marker is always
  // stripped from the full prose, so it never leaks into the normal view either.
  // `onReplyInThread`/`replyCount`: Slack-style threads — a persistent "N replies"
  // pill on agent messages that have a thread. The "Reply" initiation action itself
  // is a single floating button owned by Chat (so it stays reachable on messages
  // taller than the viewport — see Chat.svelte); this primitive only marks itself
  // threadable via `data-threadable` and renders the pill. Passed by Chat (a feature
  // component) so this primitive stays store-free.
  let {
    m,
    minimal = false,
    replyCount = 0,
    onReplyInThread,
  }: {
    m: TranscriptMessage;
    minimal?: boolean;
    replyCount?: number;
    onReplyInThread?: () => void;
  } = $props();
  const assistantSplit = $derived(m.type === "assistant" ? splitSummary(m.text ?? "") : null);
  // Threads attach only to top-level agent messages (not subagent turns), and not
  // in minimal mode (Chat doesn't pass the handler there).
  const threadable = $derived(m.type === "assistant" && !m.parentId && !!onReplyInThread);
</script>

{#if m.type === "user_local"}
  <div class="msg user" data-msg-key={m.__key}>
    <div class="body">{m.text}</div>
  </div>
{:else if m.type === "assistant"}
  <div
    class="msg assistant"
    class:subagent={m.parentId}
    data-msg-key={m.__key}
    data-threadable={threadable ? "" : undefined}
  >
    {#if m.parentId}<div class="role">subagent</div>{/if}
    {#if minimal}
      {#each assistantSplit?.bubbles ?? [] as bubble, i (i)}
        <div class="body">{bubble}</div>
      {/each}
    {:else}
      <div class="body"><Markdown text={assistantSplit?.body ?? ""} /></div>
    {/if}
    {#if threadable && replyCount > 0}
      <div class="thread-actions">
        <button type="button" class="thread-pill" onclick={onReplyInThread}>
          <MessageSquare class="size-3" />
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </button>
      </div>
    {/if}
  </div>
{:else if m.type === "system"}
  <div class="msg system">{m.text}</div>
{:else if m.type === "error"}
  <div class="msg error">⚠ {m.error}</div>
{/if}

<style>
  .role {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* Subagent turns: indented under their spawning Agent tool call with a rail. */
  .msg.subagent {
    margin-left: 16px;
    padding-left: 10px;
    border-left: 2px solid var(--app-border, var(--border));
  }

  /* Persistent "N replies" pill shown under an agent message once its thread has
     turns — an at-a-glance marker that a thread exists. The "Reply" initiation
     action lives in Chat's floating button (reachable on long messages). The pill
     stays visible in the dim color and brightens on hover. */
  .thread-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .thread-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--app-border, var(--border));
    background: transparent;
    color: var(--app-dim, var(--muted-foreground));
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.12s ease, background 0.12s ease;
  }
  .thread-pill:hover {
    color: var(--app-text, var(--foreground));
    background: var(--app-panel, var(--muted));
  }
</style>
