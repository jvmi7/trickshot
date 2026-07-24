<script lang="ts">
  // The homepage's "Ask Claude" card — the shared ChatComposer with a hero
  // shell and a launcher delivery: submit activates the backing worktree
  // FIRST (the user watches the real TUI come up on cold boots), then the
  // text lands in its focused chat and the response streams in the full
  // chat pane. Feature component (stores + session).
  import { activateWorktree, sendToCli } from "../stores";
  import { profileAccent } from "../termProfiles";
  import { basename } from "$lib/utils";
  import ChatComposer from "./ChatComposer.svelte";
  import GitBranch from "@lucide/svelte/icons/git-branch";

  let { worktree }: { worktree: string } = $props();

  async function deliver(text: string) {
    await activateWorktree(worktree);
    await sendToCli(worktree, text);
  }
</script>

<div class="composer">
  <div class="composer-head">
    <span class="composer-title">Ask Claude</span>
    <span class="composer-target" title={worktree}>
      <span class="shrink-0" style="color: {profileAccent(worktree)}">
        <GitBranch class="size-3" />
      </span>
      {basename(worktree)}
    </span>
  </div>
  <ChatComposer
    {worktree}
    autofocus={true}
    placeholder="Start a task in {basename(worktree)}… (⇧↩ for a new line)"
    onSend={deliver}
  />
  <p class="composer-hint">↵ sends and opens the chat · full history lives there</p>
</div>

<style>
  /* One-component structural CSS (split-by-reach); colors from the tokens. */
  .composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: min(680px, 100%);
    margin: 0 auto;
  }
  .composer-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .composer-title {
    font-size: var(--text-md);
    font-weight: 600;
  }
  .composer-target {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  .composer-hint {
    font-size: var(--text-2xs);
    color: var(--app-dim);
    text-align: center;
  }
</style>
