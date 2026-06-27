<script lang="ts">
  // Per-worktree git review: changed-files list + per-file diff, with stage/
  // unstage/commit/push. Refreshes on mount, on worktree change, and whenever
  // gitRefreshNonce bumps (App.svelte bumps it on turn_end). App-specific layout
  // (no shadcn counterpart) so the rows are hand-styled; controls use shadcn.
  import { selectedWorktree, gitRefreshNonce } from "../stores";
  import * as api from "../api";
  import type { GitFileStatus, GitStatus } from "../types";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import DiffView from "./DiffView.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Plus from "@lucide/svelte/icons/plus";
  import Minus from "@lucide/svelte/icons/minus";
  import Upload from "@lucide/svelte/icons/upload";

  let status = $state<GitStatus | null>(null);
  let selectedFile = $state<string | null>(null);
  let diff = $state("");
  let commitMsg = $state("");
  let busy = $state(false);
  let error = $state("");

  const wt = $derived($selectedWorktree);

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
    try {
      await fn();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
      await refresh();
    }
  }

  const stage = (f: GitFileStatus) => run(() => api.worktreeStage(wt as string, [f.path]));
  const unstage = (f: GitFileStatus) => run(() => api.worktreeUnstage(wt as string, [f.path]));
  const stageAll = () => run(() => api.worktreeStage(wt as string, []));

  function commit() {
    const w = wt;
    const msg = commitMsg.trim();
    if (!w || !msg) return;
    run(async () => {
      await api.worktreeCommit(w, msg);
      commitMsg = "";
    });
  }

  function push() {
    const w = wt;
    if (!w) return;
    run(async () => {
      try {
        await api.worktreePush(w, false);
      } catch (e) {
        // A brand-new branch has no upstream — retry establishing one.
        if (/upstream/i.test(String(e))) await api.worktreePush(w, true);
        else throw e;
      }
    });
  }

  const hasStaged = $derived(status?.files.some((f) => f.staged) ?? false);
  const dirty = $derived((status?.files.length ?? 0) > 0);
</script>

<div class="git-panel">
  {#if !wt}
    <div class="git-empty">No workspace selected.</div>
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
        <span class="git-spacer"></span>
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
        <div class="git-error">{error}</div>
      {/if}

      <div class="git-list">
        {#if !dirty}
          <div class="git-empty">Working tree clean.</div>
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

      <div class="git-commit">
        <div class="git-commit-row">
          <Button
            size="sm"
            variant="outline"
            class="h-7 text-xs"
            disabled={busy || !dirty}
            onclick={stageAll}>Stage all</Button
          >
          <Button
            size="sm"
            variant="outline"
            class="h-7 text-xs"
            title="Push current branch"
            disabled={busy}
            onclick={push}
          >
            <Upload class="size-3.5" /> Push
          </Button>
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
    </div>

    <div class="git-diff">
      {#if selectedFile}
        <DiffView {diff} />
      {:else}
        <div class="git-empty">Select a file to view its diff.</div>
      {/if}
    </div>
  {/if}
</div>

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
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .git-track {
    font-size: 11px;
    color: var(--app-dim);
  }
  .git-spacer {
    flex: 1;
  }
  .git-error {
    color: var(--destructive);
    font-size: 11px;
    padding: 6px 12px;
    white-space: pre-wrap;
    word-break: break-word;
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
    border-radius: 6px;
    padding-right: 2px;
  }
  .wt-file.active,
  .wt-file:hover {
    background: var(--accent);
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
    font-size: 10px;
    font-weight: 700;
    color: var(--app-dim);
  }
  .wt-badge.staged {
    color: var(--base-success);
  }
  .wt-path {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
  }
  .git-commit {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--app-border);
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
  .git-empty {
    color: var(--app-dim);
    font-size: 12px;
    text-align: center;
    margin-top: 32px;
    padding: 0 16px;
  }
</style>
