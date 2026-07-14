<script lang="ts">
  // Per-worktree git review: changed-files list + per-file diff, with stage/
  // unstage/commit/push. Refreshes on mount, on worktree change, and whenever
  // gitRefreshNonce bumps (App.svelte bumps it on turn_end). App-specific layout
  // (no shadcn counterpart) so the rows are hand-styled; controls use shadcn.
  import { selectedWorktree, gitRefreshNonce, activeRepo, submitTurnToChat, setMainView } from "../stores";
  import * as api from "../api";
  import type { GitFileStatus, GitStatus } from "../types";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Dialog from "$lib/components/ui/dialog";
  import DiffView from "./DiffView.svelte";
  import PrPanel from "./PrPanel.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Plus from "@lucide/svelte/icons/plus";
  import Minus from "@lucide/svelte/icons/minus";
  import Upload from "@lucide/svelte/icons/upload";
  import Download from "@lucide/svelte/icons/download";
  import RefreshCcwDot from "@lucide/svelte/icons/refresh-ccw-dot";
  import GitMerge from "@lucide/svelte/icons/git-merge";

  let status = $state<GitStatus | null>(null);
  let selectedFile = $state<string | null>(null);
  let diff = $state("");
  let commitMsg = $state("");
  let busy = $state(false);
  let error = $state("");
  // Success notice for actions with no visible effect in THIS panel (merge lands
  // in the main worktree). Cleared on the next action / refresh.
  let notice = $state("");

  const wt = $derived($selectedWorktree);
  // The repo that owns the selected worktree (its path IS the main worktree —
  // the shared `activeRepo` derivation). Merge targets it.
  const owningRepo = $derived($activeRepo);
  const isMain = $derived(!!wt && owningRepo?.path === wt);

  async function loadDiff(file: string) {
    const w = wt;
    if (!w) return;
    try {
      diff = await api.worktreeDiff(w, file);
    } catch (e) {
      diff = "";
      error = String(e);
    }
  }

  async function refresh() {
    const w = wt;
    if (!w) {
      status = null;
      return;
    }
    error = "";
    try {
      status = await api.worktreeStatus(w);
      // Drop the selection if the file is no longer changed; else reload its diff.
      if (selectedFile && !status.files.some((f) => f.path === selectedFile)) {
        selectedFile = null;
        diff = "";
      } else if (selectedFile) {
        await loadDiff(selectedFile);
      }
    } catch (e) {
      status = null;
      error = String(e);
    }
  }

  // Refetch when the worktree changes or a refresh is requested. Tracking both
  // $selectedWorktree and $gitRefreshNonce makes this run on either change.
  $effect(() => {
    void $selectedWorktree;
    void $gitRefreshNonce;
    refresh();
  });

  // ---- Pull request (gh CLI) ----
  // The whole PR subsystem lives in PrPanel.svelte; GitPanel only signals it to
  // refetch after a push/sync changes remote state (bump, don't await — prBusy
  // covers the refetch, so `busy` no longer has to span the gh call).
  let prRefreshNonce = $state(0);

  // ---- Diff-line review comments (Conductor's inline review loop) ----
  // Clicking a line's gutter glyph opens a comment box; submitting hands the
  // comment (with file/hunk/line context) to the agent as a normal turn, so it
  // iterates like a PR review.
  let lineComment = $state<{ line: string; hunk: string | null } | null>(null);
  let lineCommentText = $state("");

  function openLineComment(ctx: { line: string; hunk: string | null }) {
    lineComment = ctx;
    lineCommentText = "";
  }

  function sendLineComment() {
    const w = wt;
    const target = lineComment;
    const text = lineCommentText.trim();
    if (!w || !target || !text || !selectedFile) return;
    const hunk = target.hunk ? `\nHunk: \`${target.hunk}\`` : "";
    // Routes to the ACTIVE chat surface (CLI keystroke injection under
    // CLI-first, the GUI transcript otherwise); fire-and-forget like the send.
    void submitTurnToChat(
      w,
      `Review comment on \`${selectedFile}\`:${hunk}\nLine: \`${target.line}\`\n\n${text}\n\nPlease address this review comment in the code.`,
    );
    lineComment = null;
    lineCommentText = "";
    setMainView("chat");
  }

  function select(f: GitFileStatus) {
    selectedFile = f.path;
    loadDiff(f.path);
  }

  /** One-letter status badge. */
  function badge(f: GitFileStatus): string {
    if (f.index === "?" && f.worktree === "?") return "U";
    return (f.index !== " " ? f.index : f.worktree).trim() || "M";
  }

  async function run(fn: () => Promise<unknown>) {
    busy = true;
    error = "";
    notice = "";
    try {
      await fn();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
      await refresh();
    }
  }

  // Guard on the selected worktree (matches commit/push below) instead of casting —
  // these are only reachable when a worktree is selected, but make that explicit.
  function stage(f: GitFileStatus) {
    const w = wt;
    if (!w) return;
    run(() => api.worktreeStage(w, [f.path]));
  }
  function unstage(f: GitFileStatus) {
    const w = wt;
    if (!w) return;
    run(() => api.worktreeUnstage(w, [f.path]));
  }
  function stageAll() {
    const w = wt;
    if (!w) return;
    run(() => api.worktreeStage(w, []));
  }

  function commit() {
    const w = wt;
    const msg = commitMsg.trim();
    if (!w || !msg) return;
    run(async () => {
      await api.worktreeCommit(w, msg);
      commitMsg = "";
    });
  }

  // ---- Stateful sync (GitHub-Desktop-style single button) ----
  // The button IS the branch state: Publish (no upstream) / Push ↑N / Pull ↓N
  // (rebase, autostash) / Sync ↓N ↑N (pull --rebase then push) / Up to date.
  type SyncAction =
    | { kind: "publish" }
    | { kind: "push"; n: number }
    | { kind: "pull"; n: number }
    | { kind: "sync"; up: number; down: number }
    | { kind: "upToDate" };
  const syncAction = $derived.by((): SyncAction => {
    if (!status?.branch) return { kind: "upToDate" };
    if (!status.has_upstream) return { kind: "publish" };
    const { ahead, behind } = status;
    if (behind > 0 && ahead > 0) return { kind: "sync", up: ahead, down: behind };
    if (behind > 0) return { kind: "pull", n: behind };
    if (ahead > 0) return { kind: "push", n: ahead };
    return { kind: "upToDate" };
  });

  function doSync() {
    const w = wt;
    const a = syncAction;
    if (!w || a.kind === "upToDate") return;
    run(async () => {
      if (a.kind === "publish") await api.worktreePush(w, true);
      else if (a.kind === "push") await api.worktreePush(w, false);
      else if (a.kind === "pull") await api.worktreePull(w);
      else {
        await api.worktreePull(w);
        await api.worktreePush(w, false);
      }
      prRefreshNonce++; // remote state changed; the PR block should follow
    });
  }

  // Overwrite a stale remote with the local branch (--force-with-lease — see
  // the button's tooltip). Only offered in the diverged state.
  function forcePush() {
    const w = wt;
    if (!w) return;
    run(async () => {
      await api.worktreePush(w, false, true);
      notice = "Remote branch overwritten with your local commits.";
      prRefreshNonce++;
    });
  }

  // Merge this worktree's branch into the main worktree's checked-out branch.
  // Hidden on the main worktree itself (nothing to merge into). Conflicts land
  // in the local error state like every other command rejection.
  function merge() {
    const repo = owningRepo;
    const branch = status?.branch;
    if (!repo || !branch) return;
    run(async () => {
      await api.worktreeMerge(repo.path, branch);
      notice = `Merged ${branch} into the main worktree.`;
    });
  }

  const hasStaged = $derived(status?.files.some((f) => f.staged) ?? false);
  const dirty = $derived((status?.files.length ?? 0) > 0);
</script>

<div class="git-panel">
  {#if !wt}
    <div class="git-empty empty-state">No workspace selected.</div>
  {:else}
    <div class="git-files">
      <div class="git-head">
        <span class="git-branch">{status?.branch ?? "—"}</span>
        {#if status && (status.ahead > 0 || status.behind > 0)}
          <span class="git-track">
            {#if status.ahead > 0}↑{status.ahead}{/if}
            {#if status.behind > 0}↓{status.behind}{/if}
          </span>
        {/if}
        <span class="panel-spacer"></span>
        <Button
          size="icon"
          variant="ghost"
          class="size-7"
          title="Refresh"
          aria-label="Refresh"
          disabled={busy}
          onclick={refresh}
        >
          <RefreshCw class="size-3.5" />
        </Button>
      </div>

      {#if error}
        <div class="git-error error-text">{error}</div>
      {/if}
      {#if notice}
        <div class="git-notice notice-text">{notice}</div>
      {/if}

      <div class="git-list">
        {#if !dirty}
          <div class="git-empty empty-state">Working tree clean.</div>
        {/if}
        {#each status?.files ?? [] as f (f.path)}
          <div class="wt-file" class:active={selectedFile === f.path}>
            <button class="wt-file-main" onclick={() => select(f)} title={f.path}>
              <span class="wt-badge" class:staged={f.staged}>{badge(f)}</span>
              <span class="wt-path">{f.path}</span>
            </button>
            {#if f.staged}
              <Button
                size="icon"
                variant="ghost"
                class="size-6"
                title="Unstage"
                aria-label="Unstage"
                disabled={busy}
                onclick={() => unstage(f)}
              >
                <Minus class="size-3.5" />
              </Button>
            {:else}
              <Button
                size="icon"
                variant="ghost"
                class="size-6"
                title="Stage"
                aria-label="Stage"
                disabled={busy}
                onclick={() => stage(f)}
              >
                <Plus class="size-3.5" />
              </Button>
            {/if}
          </div>
        {/each}
      </div>

      <div class="panel-section">
        <div class="git-commit-row">
          <Button
            size="sm"
            variant="outline"
            class="h-7 text-xs"
            disabled={busy || !dirty}
            onclick={stageAll}>Stage all</Button
          >
          {#if syncAction.kind === "publish"}
            <Button size="sm" variant="outline" class="h-7 text-xs" title="Push -u origin (first publish)" disabled={busy} onclick={doSync}>
              <Upload class="size-3.5" /> Publish branch
            </Button>
          {:else if syncAction.kind === "push"}
            <Button size="sm" variant="outline" class="h-7 text-xs" title="Push {syncAction.n} commit(s)" disabled={busy} onclick={doSync}>
              <Upload class="size-3.5" /> Push ↑{syncAction.n}
            </Button>
          {:else if syncAction.kind === "pull"}
            <Button size="sm" variant="outline" class="h-7 text-xs" title="Pull with rebase (autostash)" disabled={busy} onclick={doSync}>
              <Download class="size-3.5" /> Pull ↓{syncAction.n}
            </Button>
          {:else if syncAction.kind === "sync"}
            <Button size="sm" variant="outline" class="h-7 text-xs" title="Pull with rebase, then push" disabled={busy} onclick={doSync}>
              <RefreshCcwDot class="size-3.5" /> Sync ↓{syncAction.down} ↑{syncAction.up}
            </Button>
            <Button
              size="sm"
              variant="outline"
              class="h-7 text-xs"
              title="Overwrite the remote branch with your local one (--force-with-lease: refuses if the remote gained NEW commits since the last fetch). For when the remote copy is stale — a rebase, amend, or an old push of the same work."
              disabled={busy}
              onclick={forcePush}
            >
              <Upload class="size-3.5" /> Force
            </Button>
          {:else}
            <Button size="sm" variant="outline" class="h-7 text-xs" title="Branch is in sync with its upstream" disabled>
              Up to date
            </Button>
          {/if}
          {#if !isMain && status?.branch}
            <Button
              size="sm"
              variant="outline"
              class="h-7 text-xs"
              title="Merge this branch into the main worktree"
              disabled={busy}
              onclick={merge}
            >
              <GitMerge class="size-3.5" /> Merge
            </Button>
          {/if}
        </div>
        <Textarea
          bind:value={commitMsg}
          rows={2}
          placeholder="Commit message…"
          class="min-h-0 resize-none text-xs"
        />
        <Button size="sm" class="h-7 text-xs" disabled={busy || !hasStaged || !commitMsg.trim()} onclick={commit}>
          Commit{hasStaged ? "" : " (stage files first)"}
        </Button>
      </div>

      <PrPanel
        worktree={wt}
        branch={status?.branch ?? null}
        defaultBranch={status?.default_branch ?? null}
        aheadOfDefault={status?.ahead_of_default ?? 0}
        behind={status?.behind ?? 0}
        {busy}
        refreshNonce={prRefreshNonce}
      />
    </div>

    <div class="git-diff">
      {#if selectedFile}
        <DiffView {diff} path={selectedFile} onLineComment={openLineComment} />
      {:else}
        <div class="git-empty empty-state">Select a file to view its diff.</div>
      {/if}
    </div>
  {/if}
</div>

<Dialog.Root open={!!lineComment} onOpenChange={(open) => !open && (lineComment = null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Review comment</Dialog.Title>
      <Dialog.Description>
        Sent to the agent as a turn — it addresses the comment like PR feedback.
      </Dialog.Description>
    </Dialog.Header>
    <div class="panel-form">
      <div class="line-quote">{lineComment?.line}</div>
      <Textarea
        rows={3}
        placeholder="What should change here?"
        bind:value={lineCommentText}
        class="resize-none text-xs"
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendLineComment();
        }}
      />
    </div>
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => (lineComment = null)}>Cancel</Button>
      <Button disabled={!lineCommentText.trim()} onclick={sendLineComment}>Send to agent</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .git-panel {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .git-files {
    display: flex;
    flex-direction: column;
    width: 280px;
    flex-shrink: 0;
    border-right: 1px solid var(--app-border);
    min-height: 0;
  }
  .git-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 8px 8px 12px;
    border-bottom: 1px solid var(--app-border);
  }
  .git-branch {
    font-size: var(--text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .git-track {
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  /* Text styling is the shared .error-text/.notice-text (app.css); this panel
     just adds its gutter padding. */
  .git-error,
  .git-notice {
    padding: 6px 12px;
  }
  .git-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 4px;
  }
  .wt-file {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: var(--radius-xs);
    padding-right: 2px;
  }
  .wt-file.active,
  .wt-file:hover {
    background: var(--app-panel-2);
  }
  .wt-file-main {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 5px 4px 5px 8px;
    background: none;
    border: 0;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
  }
  .wt-badge {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-size: var(--text-2xs);
    font-weight: 700;
    color: var(--app-dim);
  }
  .wt-badge.staged {
    color: var(--base-success);
  }
  .wt-path {
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
  }
  .git-commit-row {
    display: flex;
    gap: 6px;
  }
  .git-diff {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .line-quote {
    font-family: ui-monospace, monospace;
    font-size: var(--text-xs);
    padding: 6px 8px;
    border-radius: var(--radius-xs);
    background: var(--app-panel-2);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 72px;
    overflow-y: auto;
  }
  /* Text styling is the shared .empty-state (app.css); spacing stays per-site. */
  .git-empty {
    margin-top: 32px;
    padding: 0 16px;
  }
</style>
