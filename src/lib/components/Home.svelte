<script lang="ts">
  // The homepage — the center pane whenever nothing is selected: first run
  // (zero repos) AND the repos-exist-but-no-worktree state share one screen.
  // A welcome hero always; below it either the first-run onboarding (open-repo
  // CTA, CLI preflight, feature steps, sign-in notice) or the Fleet grid
  // (mission control). Feature component (reads stores by design);
  // Fleet stays the grid-only component this composes.
  import { openRepository, repos } from "../stores";
  import * as api from "../api";
  import { Button } from "$lib/components/ui/button";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Bot from "@lucide/svelte/icons/bot";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import AuthNotice from "./AuthNotice.svelte";
  import Fleet from "./Fleet.svelte";

  let picking = $state(false);
  let error = $state("");
  let ctaEl = $state<HTMLElement | null>(null);
  // The onboarding preflight: without the `claude` binary the whole app is a
  // dead end the user would only discover deep in a session failure — say it
  // HERE. "unknown" (probe rejected) stays silent rather than false-alarming.
  let cliState = $state<"checking" | "ok" | "missing" | "unknown">("checking");

  const hasRepos = $derived($repos.length > 0);

  async function probeCli() {
    cliState = "checking";
    try {
      cliState = (await api.checkCli()) ? "ok" : "missing";
    } catch {
      cliState = "unknown";
    }
  }

  // Focus the CTA on mount so plain Enter completes step one keyboard-only.
  // Programmatic (not the `autofocus` attr) — webviews honor the attribute
  // inconsistently for dynamically mounted nodes.
  $effect(() => {
    ctaEl?.focus();
  });

  $effect(() => {
    if (!hasRepos) void probeCli();
  });

  async function open() {
    if (picking) return;
    error = "";
    picking = true;
    try {
      await openRepository();
    } catch (e) {
      // The overwhelmingly common failures are picking a folder that isn't a
      // git repo, or a bare repo (both reject with git-flavored errors);
      // anything else shows raw.
      const raw = e instanceof Error ? e.message : String(e);
      error = /not a git repository/i.test(raw)
        ? "that folder isn't a git repository — pick the repo's root folder"
        : /bare repository/i.test(raw)
          ? "that's a bare repository — pick a clone with working files"
          : raw;
    } finally {
      picking = false;
    }
  }
</script>

<div class="home" class:centered={!hasRepos}>
  <div class="home-hero" class:compact={hasRepos}>
    <h1 class="wordmark">trickshot</h1>
    <p class="tagline">parallel coding agents — one per git worktree</p>

    {#if !hasRepos}
      <Button class="mt-7 gap-2" bind:ref={ctaEl} disabled={picking} onclick={open}>
        <FolderPlus class="size-4" />
        {picking ? "Opening…" : "Open a repository"}
      </Button>
      {#if error}
        <p class="pick-error">{error}</p>
      {/if}

      {#if cliState === "missing"}
        <div class="cli-notice">
          <TriangleAlert class="size-3.5 shrink-0" />
          <span>
            The <code>claude</code> CLI isn't on your PATH — trickshot drives Claude Code, so
            install it first (<code>npm i -g @anthropic-ai/claude-code</code>), then retry.
          </span>
          <Button size="sm" variant="ghost" class="h-6 shrink-0 text-xs" onclick={probeCli}>
            <RefreshCw class="size-3" /> Retry
          </Button>
        </div>
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
    {/if}
  </div>

  {#if hasRepos}
    <Fleet />
  {/if}
</div>

<style>
  /* Homepage layout: one-component structural CSS (split-by-reach); colors
     come from the shared tokens. */
  .home {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* First-run: no grid below, so the hero owns the pane and sits centered. */
  .home.centered {
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .home-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .home.centered .home-hero {
    /* optical center: the pane's true middle reads low under the 48px header */
    margin-top: -6vh;
  }
  /* Repos exist: the hero is a quiet masthead above the fleet grid. */
  .home-hero.compact {
    flex: none;
    padding: 28px 24px 4px;
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
  /* CLI-missing preflight notice (warning-toned sibling of AuthNotice). */
  .cli-notice {
    margin-top: 16px;
    max-width: 420px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid color-mix(in oklch, var(--base-warning) 35%, transparent);
    border-radius: var(--radius-xs);
    font-size: var(--text-xs);
    color: var(--app-dim);
    text-align: left;
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
