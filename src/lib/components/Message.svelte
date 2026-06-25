<script lang="ts">
  import type { TranscriptMessage } from "../types";
  import Markdown from "./Markdown.svelte";
  import { selectedWorktree } from "../stores";
  import * as api from "../api";
  import Undo2 from "@lucide/svelte/icons/undo-2";

  // Renders ONE non-tool transcript entry: assistant prose, a session notice, or
  // the UI-only user_local / error bubbles. Branch on `type`; unknown renders
  // nothing. Tool calls are NOT handled here — they're batched into ToolGroup (see
  // renderedGroups / Chat.svelte); tool_result is folded into its call.
  let { m }: { m: TranscriptMessage } = $props();

  // Revert file changes made after this user turn (file checkpoint). Guarded by
  // a confirm since it discards on-disk work.
  function doRewind(id: string | undefined) {
    const wt = $selectedWorktree;
    if (!wt || !id) return;
    if (confirm("Revert all file changes made after this message? This can't be undone.")) {
      api.rewind(wt, id);
    }
  }
</script>

{#if m.type === "user_local"}
  <div class="msg user">
    {#if m.rewindId}
      <div class="role">
        <button
          class="rewind-btn"
          title="Rewind file changes to here"
          onclick={() => doRewind(m.rewindId)}
        >
          <Undo2 class="size-3" />
        </button>
      </div>
    {/if}
    <div class="body">{m.text}</div>
  </div>
{:else if m.type === "assistant"}
  <div class="msg assistant" class:subagent={m.parentId}>
    {#if m.parentId}<div class="role">subagent</div>{/if}
    <div class="body"><Markdown text={m.text} /></div>
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
  .rewind-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--app-dim);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .msg.user:hover .rewind-btn {
    opacity: 1;
  }
  .rewind-btn:hover {
    color: var(--app-text, var(--foreground));
    background: var(--app-hover, var(--accent));
  }
  /* Subagent turns: indented under their spawning Agent tool call with a rail. */
  .msg.subagent {
    margin-left: 16px;
    padding-left: 10px;
    border-left: 2px solid var(--app-border, var(--border));
  }
</style>

