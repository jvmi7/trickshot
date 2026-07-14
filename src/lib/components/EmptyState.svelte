<script lang="ts">
  // The no-worktree-selected center pane (repos exist, nothing active). Under
  // CLI-first this replaces the deprecated Chat's empty shell so the whole GUI
  // chat subtree stays out of the live component tree (see CHAT_SURFACE in
  // stores.ts). Prop-driven primitive: text in, centered dim text out.
  let { text = "Select or create a worktree on the left." }: { text?: string } = $props();
</script>

<div class="pane">
  <div class="empty-state">{text}</div>
</div>

<style>
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
