<script lang="ts">
  import { activePending, selectedWorktree, setPendingPermission } from "../stores";
  import * as api from "../api";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import Collapsible from "./Collapsible.svelte";

  // Stringify the tool input once per change (matches ToolActivity's `inputJson`).
  // A Write/Edit input can carry whole-file contents, so it must be bounded by
  // Collapsible, not dumped raw into the DOM — keep the cast/stringify out of markup.
  const inputJson = $derived(JSON.stringify($activePending?.input, null, 2));

  function decide(behavior: "allow" | "deny") {
    const p = $activePending;
    const wt = $selectedWorktree;
    if (!p || !wt) return;
    api.replyPermission(wt, p.id, behavior);
    setPendingPermission(wt, null);
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
    <div class="perm-input"><Collapsible text={inputJson} /></div>
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => decide("deny")}>Deny</Button>
      <Button onclick={() => decide("allow")}>Allow</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Container chrome only; the inner text styling lives in Collapsible. */
  .perm-input {
    background: var(--app-bg);
    border: 1px solid var(--app-border);
    border-radius: 8px;
    padding: 12px;
    max-height: 300px;
    overflow: auto;
  }
</style>
