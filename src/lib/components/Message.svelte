<script lang="ts">
  import type { TranscriptMessage } from "../types";
  import Markdown from "./Markdown.svelte";

  // Renders ONE non-tool transcript entry: assistant prose, a session notice, or
  // the UI-only user_local / error bubbles. Branch on `type`; unknown renders
  // nothing. Tool calls are NOT handled here — they're batched into ToolGroup (see
  // renderedGroups / Chat.svelte); tool_result is folded into its call.
  let { m }: { m: TranscriptMessage } = $props();
</script>

{#if m.type === "user_local"}
  <div class="msg user">
    <div class="body">{m.text}</div>
  </div>
{:else if m.type === "assistant"}
  <div class="msg assistant">
    <div class="body"><Markdown text={m.text} /></div>
  </div>
{:else if m.type === "system"}
  <div class="msg system">{m.text}</div>
{:else if m.type === "error"}
  <div class="msg error">⚠ {m.error}</div>
{/if}
