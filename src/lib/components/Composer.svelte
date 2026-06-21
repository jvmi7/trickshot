<script lang="ts">
  import { messages, sessionActive } from "../stores";
  import * as api from "../api";

  let text = "";

  function send() {
    const t = text.trim();
    if (!t || !$sessionActive) return;
    // Optimistically render the user's own turn (the SDK echoes user turns as
    // tool-result-bearing "user" messages, which Message.svelte renders separately).
    messages.update((m) => [...m, { type: "user_local", text: t }]);
    api.sendUserTurn(t);
    text = "";
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="composer">
  <textarea
    bind:value={text}
    on:keydown={onKeydown}
    disabled={!$sessionActive}
    placeholder={$sessionActive ? "Message Claude…  (Enter to send, Shift+Enter for newline)" : "Start a session first"}
  ></textarea>
  <div class="composer-actions">
    <button on:click={() => api.interruptAgent()} disabled={!$sessionActive}>Stop</button>
    <button class="primary" on:click={send} disabled={!$sessionActive}>Send</button>
  </div>
</div>
