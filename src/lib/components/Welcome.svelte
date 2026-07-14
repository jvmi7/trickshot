<script lang="ts">
  import { openRepository } from "../stores";
  import { Button } from "$lib/components/ui/button";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Bot from "@lucide/svelte/icons/bot";
  import AuthNotice from "./AuthNotice.svelte";

  let picking = $state(false);
  let error = $state("");
  let ctaEl = $state<HTMLElement | null>(null);

  // Focus the CTA on mount so plain Enter completes step one keyboard-only.
  // Programmatic (not the `autofocus` attr) — webviews honor the attribute
  // inconsistently for dynamically mounted nodes.
  $effect(() => {
    ctaEl?.focus();
  });

  async function open() {
    if (picking) return;
    error = "";
    picking = true;
    try {
      await openRepository();
    } catch (e) {
      // The overwhelmingly common failure is picking a folder that isn't a git
      // repo (list_worktrees rejects with git's stderr); anything else shows raw.
      const raw = e instanceof Error ? e.message : String(e);
      error = /not a git repository/i.test(raw)
        ? "that folder isn't a git repository — pick the repo's root folder"
        : raw;
    } finally {
      picking = false;
    }
  }
</script>

<div class="welcome">
  <div class="welcome-inner">
    <h1 class="wordmark">trickshot</h1>
    <p class="tagline">parallel coding agents — one per git worktree</p>

    <Button class="mt-7 gap-2" bind:ref={ctaEl} disabled={picking} onclick={open}>
      <FolderPlus class="size-4" />
      {picking ? "Opening…" : "Open a repository"}
    </Button>
    {#if error}
      <p class="pick-error">{error}</p>
    {/if}

    <div class="steps">
      <div class="step">
        <FolderPlus class="size-3.5 shrink-0" />
        <span>one repo → many worktrees, one per task</span>
      </div>
      <div class="step">
        <GitBranch class="size-3.5 shrink-0" />
        <span>every worktree gets its own live agent</span>
      </div>
      <div class="step">
        <Bot class="size-3.5 shrink-0" />
        <span>agents keep running while you switch</span>
      </div>
    </div>

    <AuthNotice class="mt-8 max-w-sm p-3 text-left" />
  </div>
</div>

<style>
  /* First-run pane: fills the center content slot; one-component layout, so it
     lives here (split-by-reach) and colors come from the shared tokens. */
  .welcome {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .welcome-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    /* optical center: the pane's true middle reads low under the 48px header */
    margin-top: -6vh;
  }
  .wordmark {
    font-size: 20px; /* conformance-allowlisted: one-off display size, off the token scale */
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--app-text);
  }
  .tagline {
    margin-top: 6px;
    font-size: var(--text-md);
    color: var(--app-dim);
  }
  .pick-error {
    margin-top: 10px;
    max-width: 340px;
    font-size: var(--text-sm);
    color: var(--app-danger);
  }
  .steps {
    margin-top: 36px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: left;
  }
  .step {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--text-sm);
    color: var(--app-dim);
  }
</style>
