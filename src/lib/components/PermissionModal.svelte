<script lang="ts">
  import { activePending, selectedWorktree, pendingPermission } from "../stores";
  import * as api from "../api";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";

  function decide(behavior: "allow" | "deny") {
    const p = $activePending;
    const wt = $selectedWorktree;
    if (!p || !wt) return;
    api.replyPermission(wt, p.id, behavior);
    pendingPermission.update((m) => ({ ...m, [wt]: null }));
  }

  // Closing the dialog (Esc / overlay / ✕) is treated as a deny — the safe default.
  function onOpenChange(open: boolean) {
    if (!open && $activePending) decide("deny");
  }
</script>

<Dialog.Root open={!!$activePending} {onOpenChange}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Allow <code>{$activePending?.tool}</code>?</Dialog.Title>
      <Dialog.Description>The agent wants to run this tool in the active worktree.</Dialog.Description>
    </Dialog.Header>
    <pre class="perm-input">{JSON.stringify($activePending?.input, null, 2)}</pre>
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => decide("deny")}>Deny</Button>
      <Button onclick={() => decide("allow")}>Allow</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .perm-input {
    background: var(--app-bg);
    border: 1px solid var(--app-border);
    border-radius: 8px;
    padding: 12px;
    max-height: 300px;
    overflow: auto;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
