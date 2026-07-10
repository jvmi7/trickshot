<script lang="ts">
  // Pull-request block of the git panel (gh CLI): PR status + checks, the
  // create-PR dialog, and Conductor's "forward failing checks" handoff to the
  // agent. PR state is fetched on worktree change / after push/create — NOT on
  // every gitRefreshNonce bump, which fires per agent turn (gh is a network
  // call); GitPanel bumps `refreshNonce` when a sync changes remote state.
  import { setMainView, submitUserTurn } from "../stores";
  import * as api from "../api";
  import type { PrInfo } from "../types";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Input } from "$lib/components/ui/input";
  import { Switch } from "$lib/components/ui/switch";
  import * as Dialog from "$lib/components/ui/dialog";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import GitPullRequest from "@lucide/svelte/icons/git-pull-request";
  import Wrench from "@lucide/svelte/icons/wrench";

  let {
    worktree,
    branch,
    defaultBranch,
    aheadOfDefault,
    behind,
    busy,
    refreshNonce,
  }: {
    worktree: string;
    branch: string | null;
    defaultBranch: string | null;
    /** Commits over the default branch (drives PR eligibility). */
    aheadOfDefault: number;
    /** Commits behind the upstream (drives the "Sync before PR" hint). */
    behind: number;
    /** GitPanel's git-command busy flag — gates the agent handoff like its other actions. */
    busy: boolean;
    /** Bumped by GitPanel after a push/sync so the PR block refetches remote state. */
    refreshNonce: number;
  } = $props();

  let pr = $state<PrInfo | null>(null);
  let prLoaded = $state(false);
  let prBusy = $state(false);
  let prError = $state("");
  let prDialogOpen = $state(false);
  let prTitle = $state("");
  let prBody = $state("");
  let prBase = $state("");
  let prDraft = $state(false);

  const failingChecks = $derived(pr?.checks.filter((c) => c.status === "fail").length ?? 0);

  // PR eligibility (drives WHICH of button/hint the block renders).
  const onDefaultBranch = $derived(!!branch && !!defaultBranch && branch === defaultBranch);
  const canProposePr = $derived(!onDefaultBranch && aheadOfDefault > 0);

  // Reset + refetch when the selection changes.
  $effect(() => {
    void worktree;
    pr = null;
    prLoaded = false;
    prError = "";
    refreshPr();
  });

  // Refetch (without resetting) when GitPanel signals the remote changed. The
  // initial 0 is skipped — the worktree effect above already covers the mount.
  $effect(() => {
    if (refreshNonce > 0) refreshPr();
  });

  async function refreshPr() {
    prBusy = true;
    prError = "";
    try {
      pr = await api.prStatus(worktree);
      prLoaded = true;
    } catch (e) {
      prError = String(e);
    } finally {
      prBusy = false;
    }
  }

  function openPrDialog() {
    prTitle = branch ?? "";
    prBody = "";
    prBase = "";
    prDraft = false;
    prDialogOpen = true;
  }

  async function createPr() {
    if (!prTitle.trim()) return;
    prBusy = true;
    prError = "";
    try {
      // The branch must exist on the remote before `gh pr create`.
      try {
        await api.worktreePush(worktree, false);
      } catch (e) {
        if (/upstream/i.test(String(e))) await api.worktreePush(worktree, true);
        else throw e;
      }
      await api.prCreate(worktree, prTitle, prBody, prBase.trim() || undefined, prDraft);
      prDialogOpen = false;
      await refreshPr();
    } catch (e) {
      prError = String(e);
    } finally {
      prBusy = false;
    }
  }

  // Conductor's "forward failing checks": hand the failing check names/links to
  // the agent as a normal turn and jump back to the chat to watch it work.
  function fixChecks() {
    if (!pr) return;
    const failing = pr.checks.filter((c) => c.status === "fail");
    if (!failing.length) return;
    const lines = failing.map((c) => `- ${c.name}${c.link ? ` (${c.link})` : ""}`).join("\n");
    submitUserTurn(
      worktree,
      `Our PR "${pr.title}" (#${pr.number}) has failing CI checks:\n${lines}\n\nInvestigate why they fail and fix them.`,
    );
    setMainView("chat");
  }
</script>

<div class="panel-section">
  <div class="git-pr-head">
    <GitPullRequest class="size-3.5" />
    <span class="section-label">Pull request</span>
    <span class="panel-spacer"></span>
    <Button
      size="icon"
      variant="ghost"
      class="size-6"
      title="Refresh PR status"
      aria-label="Refresh PR status"
      disabled={prBusy}
      onclick={refreshPr}
    >
      <RefreshCw class="size-3" />
    </Button>
  </div>
  {#if prError}
    <div class="git-error error-text">{prError}</div>
  {:else if !prLoaded}
    <div class="git-pr-dim">{prBusy ? "Checking…" : "—"}</div>
  {:else if pr}
    <a class="git-pr-link" href={pr.url} target="_blank" rel="noreferrer">
      #{pr.number} {pr.title}
    </a>
    <div class="git-pr-meta">
      <span class="git-pr-state {pr.state.toLowerCase()}">{pr.is_draft ? "draft" : pr.state.toLowerCase()}</span>
      <span class="git-pr-dim">→ {pr.base}</span>
    </div>
    {#if pr.checks.length > 0}
      <div class="git-checks">
        {#each pr.checks as c (c.name)}
          <div class="git-check">
            <span class="git-check-dot {c.status}"></span>
            {#if c.link}
              <a class="git-check-name" href={c.link} target="_blank" rel="noreferrer">{c.name}</a>
            {:else}
              <span class="git-check-name">{c.name}</span>
            {/if}
          </div>
        {/each}
      </div>
      {#if failingChecks > 0}
        <Button size="sm" variant="outline" class="h-7 text-xs" disabled={busy} onclick={fixChecks}>
          <Wrench class="size-3.5" /> Fix failing checks with agent
        </Button>
      {/if}
    {/if}
  {:else if onDefaultBranch}
    <div class="git-pr-dim">
      You're on {defaultBranch} — the PR base. Create a worktree branch to open a PR.
    </div>
  {:else if !canProposePr}
    <div class="git-pr-dim">
      No commits over {defaultBranch ?? "the base branch"} yet — commit changes first.
    </div>
  {:else}
    {#if behind > 0}
      <div class="git-pr-dim">Branch is behind its upstream — Sync before opening the PR.</div>
    {/if}
    <Button size="sm" variant="outline" class="h-7 text-xs" disabled={prBusy} onclick={openPrDialog}>
      <GitPullRequest class="size-3.5" /> Create PR
    </Button>
  {/if}
</div>

<Dialog.Root bind:open={prDialogOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Create pull request</Dialog.Title>
      <Dialog.Description>
        Pushes the branch, then opens the PR with <code>gh pr create</code>.
      </Dialog.Description>
    </Dialog.Header>
    <div class="panel-form">
      <Input placeholder="Title" bind:value={prTitle} />
      <Textarea rows={4} placeholder="Description (optional)" bind:value={prBody} class="resize-none text-xs" />
      <Input placeholder="Base branch (default: repo default)" bind:value={prBase} />
      <label class="pr-draft">
        <Switch bind:checked={prDraft} />
        <span>Draft PR</span>
      </label>
      {#if prError}
        <div class="git-error error-text">{prError}</div>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => (prDialogOpen = false)}>Cancel</Button>
      <Button disabled={prBusy || !prTitle.trim()} onclick={createPr}>
        {prBusy ? "Creating…" : "Create PR"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Text styling is the shared .error-text (app.css); this block just adds its
     gutter padding (matches GitPanel's remainder). */
  .git-error {
    padding: 6px 12px;
  }
  .git-pr-head {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--app-dim);
  }
  .git-pr-link {
    font-size: var(--text-sm);
    font-weight: 600;
    color: inherit;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .git-pr-link:hover {
    text-decoration: underline;
  }
  .git-pr-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
  }
  .git-pr-state {
    font-weight: 600;
    text-transform: lowercase;
  }
  .git-pr-state.open {
    color: var(--base-success);
  }
  .git-pr-state.merged {
    color: var(--app-dim);
  }
  .git-pr-state.closed {
    color: var(--app-danger);
  }
  .git-pr-dim {
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  .git-checks {
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 140px;
    overflow-y: auto;
  }
  .git-check {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .git-check-dot {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--app-dim);
  }
  .git-check-dot.pass {
    background: var(--base-success);
  }
  .git-check-dot.fail {
    background: var(--app-danger);
  }
  .git-check-dot.pending {
    background: var(--base-warning);
  }
  .git-check-name {
    font-size: var(--text-xs);
    color: inherit;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  a.git-check-name:hover {
    text-decoration: underline;
  }
  .pr-draft {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-sm);
  }
</style>
