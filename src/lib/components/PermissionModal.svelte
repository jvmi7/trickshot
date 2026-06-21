<script lang="ts">
  import { pendingPermission } from "../stores";
  import * as api from "../api";

  function decide(behavior: "allow" | "deny") {
    const p = $pendingPermission;
    if (!p) return;
    api.replyPermission(p.id, behavior);
    pendingPermission.set(null);
  }
</script>

{#if $pendingPermission}
  <div class="overlay">
    <div class="dialog">
      <h3>Allow <code>{$pendingPermission.tool}</code>?</h3>
      <pre>{JSON.stringify($pendingPermission.input, null, 2)}</pre>
      <div class="row">
        <button on:click={() => decide("deny")}>Deny</button>
        <button class="primary" on:click={() => decide("allow")}>Allow</button>
      </div>
    </div>
  </div>
{/if}
