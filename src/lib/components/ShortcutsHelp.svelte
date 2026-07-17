<script lang="ts">
  // ⌘/ keyboard-shortcuts overlay: the discoverability surface for the global
  // bindings App.svelte owns (they otherwise live only in code). Feature
  // component (reads the open-state store); the rows are data-driven so a new
  // binding is one array entry.
  import { setShortcutsHelpOpen, shortcutsHelpOpen } from "../stores";
  import * as Dialog from "$lib/components/ui/dialog";

  const SHORTCUTS: { keys: string[]; what: string }[] = [
    { keys: ["⌘K"], what: "Command palette" },
    { keys: ["⌘⇧N"], what: "New worktree" },
    { keys: ["⌘⇧D", "⌘⇧P"], what: "Changes & pull request" },
    { keys: ["⌘1…9"], what: "Jump to the Nth worktree" },
    { keys: ["⌘,"], what: "Settings" },
    { keys: ["Esc"], what: "Leave Settings / close dialogs" },
    { keys: ["⌘/"], what: "This overlay" },
  ];
</script>

<Dialog.Root open={$shortcutsHelpOpen} onOpenChange={setShortcutsHelpOpen}>
  <Dialog.Content class="max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Keyboard shortcuts</Dialog.Title>
    </Dialog.Header>
    <div class="shortcut-list">
      {#each SHORTCUTS as s (s.what)}
        <div class="shortcut-row">
          <span class="shortcut-keys">
            {#each s.keys as k, i (k)}
              {#if i > 0}<span class="shortcut-or">or</span>{/if}
              <kbd>{k}</kbd>
            {/each}
          </span>
          <span class="shortcut-what">{s.what}</span>
        </div>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>

<style>
  .shortcut-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .shortcut-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .shortcut-keys {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 108px;
  }
  .shortcut-or {
    font-size: var(--text-2xs);
    color: var(--app-dim);
  }
  kbd {
    padding: 2px 6px;
    font-family: var(--app-font-mono);
    font-size: var(--text-2xs);
    color: var(--app-text);
    background: var(--app-panel-2);
    border: 1px solid var(--app-border);
    border-radius: var(--radius-2xs);
  }
  .shortcut-what {
    font-size: var(--text-sm);
    color: var(--app-dim);
  }
</style>
