<script lang="ts">
  import type { TranscriptMessage } from "../types";
  import Collapsible from "./Collapsible.svelte";

  // Renders ONE provider-neutral transcript entry (see AgentMessage in
  // shared/protocol.ts) plus the two UI-only bubbles (user_local / error).
  // Branch on `type`; an unknown type renders nothing.
  export let m: TranscriptMessage;
</script>

{#if m.type === "user_local"}
  <div class="msg user">
    <div class="role">you</div>
    <div class="body">{m.text}</div>
  </div>
{:else if m.type === "assistant"}
  <div class="msg assistant">
    <div class="role">assistant</div>
    <div class="body"><p class="text">{m.text}</p></div>
  </div>
{:else if m.type === "tool_call"}
  <div class="msg assistant">
    <div class="body">
      <div class="tool-use">
        <span class="tool-name">🔧 {m.name}</span>
        <Collapsible text={JSON.stringify(m.input, null, 2)} />
      </div>
    </div>
  </div>
{:else if m.type === "tool_result"}
  <div class="msg tool-result">
    <div class="role">result</div>
    <Collapsible text={m.content} />
  </div>
{:else if m.type === "system"}
  <div class="msg system">{m.text}</div>
{:else if m.type === "error"}
  <div class="msg error">⚠ {m.error}</div>
{/if}
