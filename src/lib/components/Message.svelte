<script lang="ts">
  import type { SDKMessageLike } from "../types";

  export let m: SDKMessageLike;

  // The Agent SDK nests Anthropic message content under `message.content`.
  function blocks(): any[] {
    const content = (m as any)?.message?.content;
    return Array.isArray(content) ? content : [];
  }
</script>

{#if m.type === "user_local"}
  <div class="msg user">
    <div class="role">you</div>
    <div class="body">{m.text}</div>
  </div>
{:else if m.type === "assistant"}
  <div class="msg assistant">
    <div class="role">claude</div>
    <div class="body">
      {#each blocks() as b}
        {#if b.type === "text"}
          <p class="text">{b.text}</p>
        {:else if b.type === "tool_use"}
          <div class="tool-use">
            <span class="tool-name">🔧 {b.name}</span>
            <pre>{JSON.stringify(b.input, null, 2)}</pre>
          </div>
        {/if}
      {/each}
    </div>
  </div>
{:else if m.type === "user"}
  {#each blocks() as b}
    {#if b.type === "tool_result"}
      <div class="msg tool-result">
        <div class="role">result</div>
        <pre>{typeof b.content === "string" ? b.content : JSON.stringify(b.content, null, 2)}</pre>
      </div>
    {/if}
  {/each}
{:else if m.type === "result"}
  <div class="msg result">✓ {m.result ?? "done"}</div>
{:else if m.type === "system"}
  <div class="msg system">
    session started{m.model ? ` · ${m.model}` : ""}
  </div>
{:else if m.type === "error"}
  <div class="msg error">⚠ {m.error}</div>
{/if}
