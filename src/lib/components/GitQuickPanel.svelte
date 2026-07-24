<script lang="ts">
  // The COMPACT Changes popover (the header ± trigger): a glanceable
  // changed-file count and ONE stateful action button that walks the branch's
  // lifecycle — Create PR → Update PR → Merge PR → Archive worktree (once
  // merged). The FULL review surface (per-file diffs, stage/commit, the
  // review queue) lives one click deeper: the files row opens GitPanel in a
  // modal (reviewDialogOpen — ViewToggle mounts the dialog OUTSIDE this
  // popover so it survives the popover closing). Feature component.
  import {
    activeRepo,
    ArchiveHookError,
    archiveWorkspace,
    bumpGitRefresh,
    gitRefreshNonce,
    selectedWorktree,
    setChangesOpen,
    setReviewDialogOpen,
    worktreesByRepo,
  } from "../stores";
  import * as api from "../api";
  import type { GitStatus, PrInfo } from "../types";
  import { Button } from "$lib/components/ui/button";
  import Archive from "@lucide/svelte/icons/archive";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import FileDiff from "@lucide/svelte/icons/file-diff";
  import GitMerge from "@lucide/svelte/icons/git-merge";
  import GitPullRequestArrow from "@lucide/svelte/icons/git-pull-request-arrow";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Upload from "@lucide/svelte/icons/upload";

  let status = $state<GitStatus | null>(null);
  let pr = $state<PrInfo | null>(null);
  // False once pr_status rejects (gh missing / not authed): the lifecycle
  // button degrades to plain commit-and-push instead of dead PR verbs.
  let prSupported = $state(true);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");

  const wt = $derived($selectedWorktree);
  const owningRepo = $derived($activeRepo);
  // The main worktree can't PR against itself — it gets the sync fallback.
  const isMain = $derived(!!wt && owningRepo?.path === wt);

  async function refresh() {
    const w = wt;
    if (!w) {
      status = null;
      pr = null;
      return;
    }
    error = "";
    try {
      status = await api.worktreeStatus(w);
    } catch (e) {
      status = null;
      error = String(e);
    }
    try {
      pr = await api.prStatus(w);
      prSupported = true;
    } catch {
      pr = null;
      prSupported = false;
    }
  }

  // Refetch on worktree change and on the shared refresh nonce (turn end).
  $effect(() => {
    void $selectedWorktree;
    void $gitRefreshNonce;
    refresh();
  });

  const fileCount = $derived(status?.files.length ?? 0);
  const dirty = $derived(fileCount > 0);
  // Anything the remote hasn't seen: an unpublished branch or local commits.
  const unpushed = $derived(!!status && (!status.has_upstream || status.ahead > 0));

  type ActionId = "create" | "update" | "merge" | "archive" | "sync";
  const action = $derived.by((): { id: ActionId; label: string } | null => {
    if (!status) return null;
    if (isMain || !prSupported) {
      // No PR lifecycle here — offer the plain sync when there's work to send.
      return dirty || unpushed ? { id: "sync", label: "Commit & push" } : null;
    }
    if (pr?.state === "MERGED") return { id: "archive", label: "Archive worktree" };
    if (pr?.state === "OPEN") {
      return dirty || unpushed
        ? { id: "update", label: "Update pull request" }
        : { id: "merge", label: "Merge pull request" };
    }
    // No PR yet (or a closed one): the popover only shows when there's
    // something to review, so Create is always meaningful here.
    return { id: "create", label: "Create pull request" };
  });

  /** Land local work on the remote: stage everything, commit (AI message,
   *  falling back to a plain one), push (-u covers unpublished branches). */
  async function syncBranch(w: string) {
    if (dirty) {
      await api.worktreeStage(w, []);
      let msg: string;
      try {
        msg = await api.generateCommitMessage(w);
      } catch {
        msg = `chore: update ${status?.branch ?? "worktree"}`;
      }
      await api.worktreeCommit(w, msg);
    }
    if (dirty || unpushed) await api.worktreePush(w, true);
  }

  async function run() {
    const w = wt;
    const act = action;
    const repo = owningRepo;
    if (!w || !act || busy) return;
    busy = true;
    error = "";
    notice = "";
    try {
      if (act.id === "create") {
        await syncBranch(w);
        // AI title/body when available; the branch name is an honest fallback.
        let text = { title: status?.branch ?? "Update", body: "" };
        try {
          text = await api.generatePrText(w);
        } catch {
          // claude -p unavailable / nothing to summarize — keep the fallback
        }
        await api.prCreate(w, text.title, text.body);
        notice = "Pull request created";
      } else if (act.id === "update" || act.id === "sync") {
        await syncBranch(w);
        notice = act.id === "update" ? "Pull request updated" : "Committed & pushed";
      } else if (act.id === "merge") {
        await api.prMerge(w);
        notice = "Pull request merged";
      } else if (act.id === "archive") {
        if (dirty) {
          throw new Error(
            "uncommitted changes here — archive from the sidebar to confirm discarding them",
          );
        }
        const wtObj = ($worktreesByRepo[repo?.path ?? ""] ?? []).find((x) => x.path === w);
        if (!repo || !wtObj) throw new Error("worktree not found");
        await archiveWorkspace(repo.path, wtObj);
        setChangesOpen(false);
        return; // the worktree is gone — nothing to refresh
      }
      bumpGitRefresh(); // sidebar ± glances + this panel (via the nonce effect)
    } catch (e) {
      error =
        e instanceof ArchiveHookError
          ? `archive script failed: ${e.message} — archive from the sidebar to skip the hook`
          : String(e);
    } finally {
      busy = false;
    }
  }

  function openReview() {
    setChangesOpen(false);
    setReviewDialogOpen(true);
  }
</script>

<div class="git-quick">
  <button class="git-quick-files" title="Review the full diff" onclick={openReview}>
    <FileDiff class="size-3.5 shrink-0" />
    <span>{fileCount} changed file{fileCount === 1 ? "" : "s"}</span>
    {#if status}
      {@const s = status}
      <span class="git-quick-stat">
        {#if s.insertions > 0}<span class="diff-add">+{s.insertions}</span>{/if}
        {#if s.deletions > 0}<span class="diff-del">−{s.deletions}</span>{/if}
      </span>
    {/if}
    <ChevronRight class="size-3 shrink-0 git-quick-chevron" />
  </button>

  {#if pr}
    <a class="git-quick-pr" href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>
      <span class="git-quick-pr-state" data-state={pr.state.toLowerCase()}
        >{pr.state.toLowerCase()}</span
      >
      <span class="git-quick-pr-title">#{pr.number} · {pr.title}</span>
    </a>
  {/if}

  {#if error}<p class="error-text">{error}</p>{/if}
  {#if notice}<p class="notice-text">{notice}</p>{/if}

  {#if action}
    <Button class="w-full gap-1.5" size="sm" disabled={busy} onclick={run}>
      {#if busy}
        <LoaderCircle class="size-3.5 animate-spin" />
      {:else if action.id === "create" || action.id === "update"}
        <GitPullRequestArrow class="size-3.5" />
      {:else if action.id === "merge"}
        <GitMerge class="size-3.5" />
      {:else if action.id === "archive"}
        <Archive class="size-3.5" />
      {:else}
        <Upload class="size-3.5" />
      {/if}
      {action.label}
    </Button>
  {/if}
</div>

<style>
  /* A small MENU, not a panel: one-component structural CSS (split-by-reach);
     colors from the shared tokens. */
  .git-quick {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 260px;
    padding: 10px;
  }
  .git-quick-files {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--app-text);
    background: none;
    border: none;
    border-radius: var(--radius-xs);
    cursor: pointer;
    transition: background var(--app-duration-fast);
  }
  .git-quick-files:hover {
    background: var(--app-panel-2);
  }
  .git-quick-stat {
    display: inline-flex;
    gap: 5px;
    font-size: var(--text-xs);
  }
  .git-quick-files :global(.git-quick-chevron) {
    margin-left: auto;
    color: var(--app-dim);
  }
  .git-quick-pr {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0 8px;
    font-size: var(--text-xs);
    color: var(--app-dim);
    text-decoration: none;
  }
  .git-quick-pr:hover {
    color: var(--app-text);
  }
  .git-quick-pr-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .git-quick-pr-state {
    flex-shrink: 0;
    font-weight: 600;
    text-transform: uppercase;
    font-size: var(--text-2xs);
    letter-spacing: 0.04em;
  }
  .git-quick-pr-state[data-state="open"] {
    color: var(--base-success);
  }
  .git-quick-pr-state[data-state="merged"] {
    color: var(--app-accent);
  }
  .git-quick-pr-state[data-state="closed"] {
    color: var(--app-danger);
  }
</style>
