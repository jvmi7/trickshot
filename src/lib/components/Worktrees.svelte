<script lang="ts">
  import { tick } from "svelte";
  import {
    repos,
    addRepo,
    worktreesByRepo,
    setWorktrees,
    addWorktree,
    removeWorktreeFromRepo,
    selectedWorktree,
    sessionStatus,
    setStatus,
    clearStatus,
    ensureSession,
    resetTranscript,
    forgetWorktreeSession,
    setCenterView,
    unreadByWorktree,
    clearUnread,
    pendingPermission,
  } from "../stores";
  import * as api from "../api";
  import { basename } from "../utils";
  import type { Worktree } from "../types";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import IconButton from "./IconButton.svelte";
  import House from "@lucide/svelte/icons/house";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  let creatingFor = $state<string | null>(null); // repo path the inline create field is open for
  let collapsed = $state<Record<string, boolean>>({}); // repo paths whose worktree list is folded
  function toggleRepo(path: string) {
    collapsed = { ...collapsed, [path]: !collapsed[path] };
  }
  let newBranch = $state("");
  let creating = $state(false);
  let error = $state("");
  // null (not undefined): Input's `ref` is $bindable(null); Svelte throws on
  // bind:ref={undefined} when the bindable has a fallback value.
  let branchInput = $state<HTMLInputElement | null>(null);

  async function pickAndAddRepo() {
    error = "";
    try {
      const p = await api.pickDirectory();
      if (!p) return;
      addRepo({ path: p, name: basename(p) });
      await refresh(p);
    } catch (e) {
      error = String(e);
    }
  }

  async function refresh(repoPath: string) {
    try {
      const wts = await api.listWorktrees(repoPath);
      setWorktrees(repoPath, wts);
    } catch (e) {
      error = String(e);
    }
  }

  // Selecting a worktree = activating its session (no manual start/stop) and
  // returning the center pane to the chat (leaving the Settings page if open).
  async function select(wt: Worktree) {
    selectedWorktree.set(wt.path);
    setCenterView("chat");
    clearUnread(wt.path);
    try {
      // Resume this worktree's prior session (context) if we have one persisted,
      // applying its saved permission mode (default: bypassPermissions).
      await ensureSession(wt.path);
      setStatus(wt.path, "ready");
    } catch (e) {
      error = String(e);
    }
  }

  async function startCreate(repoPath: string) {
    creatingFor = repoPath;
    newBranch = "";
    await tick();
    branchInput?.focus();
  }

  async function create(repoPath: string) {
    const branch = newBranch.trim();
    if (!branch || creating) return;
    creating = true;
    error = "";
    try {
      const wt = await api.createWorktree(repoPath, branch);
      addWorktree(repoPath, wt);
      creatingFor = null;
      newBranch = "";
      await select(wt);
    } catch (e) {
      error = String(e);
    } finally {
      creating = false;
    }
  }

  async function remove(repoPath: string, wt: Worktree, e: Event) {
    e.stopPropagation();
    error = "";
    try {
      // Guard against silently discarding uncommitted work (we force-remove below).
      try {
        const st = await api.worktreeStatus(wt.path);
        if (
          st.files.length > 0 &&
          !confirm(
            `"${wt.branch ?? wt.path}" has ${st.files.length} uncommitted change${st.files.length === 1 ? "" : "s"}. Remove anyway and discard them?`,
          )
        ) {
          return;
        }
      } catch {
        // status check failed (e.g. not a git dir) — proceed with removal
      }
      await api.stopSession(wt.path);
      await api.removeWorktree(repoPath, wt.path, true);
      resetTranscript(wt.path);
      forgetWorktreeSession(wt.path);
      clearStatus(wt.path);
      removeWorktreeFromRepo(repoPath, wt.path);
      if ($selectedWorktree === wt.path) selectedWorktree.set(null);
    } catch (err) {
      error = String(err);
    }
  }
</script>

<div class="wt">
  <div class="wt-section">
    <span>Projects</span>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <IconButton {...props} aria-label="Add repository" onclick={pickAndAddRepo}>
            <FolderPlus />
          </IconButton>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Add repository</Tooltip.Content>
    </Tooltip.Root>
  </div>

  {#each $repos as repo (repo.path)}
    <div class="repo-group group/repo">
      <div class="repo-head">
        <button
          class="repo-toggle"
          title={repo.path}
          aria-expanded={!collapsed[repo.path]}
          onclick={() => toggleRepo(repo.path)}
        >
          <span class="repo-chevron" class:collapsed={collapsed[repo.path]}><ChevronDown class="size-3.5" /></span>
          <span class="repo-name">{repo.name}</span>
        </button>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <IconButton
                {...props}
                class="opacity-0 group-hover/repo:opacity-100"
                aria-label="New worktree"
                onclick={() => startCreate(repo.path)}
              >
                <Plus />
              </IconButton>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>New worktree</Tooltip.Content>
        </Tooltip.Root>
      </div>

      {#if !collapsed[repo.path]}
        {#if creatingFor === repo.path}
          <Input
            class="my-1"
            placeholder="branch name…  (Enter)"
            bind:value={newBranch}
            bind:ref={branchInput}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === "Enter") create(repo.path);
              else if (e.key === "Escape") creatingFor = null;
            }}
            onblur={() => (creatingFor = null)}
          />
        {/if}

        <div class="wt-rows">
          {#each $worktreesByRepo[repo.path] ?? [] as wt (wt.path)}
          <div
            class="wt-row group/row"
            class:active={$selectedWorktree === wt.path}
            role="button"
            tabindex="0"
            onclick={() => select(wt)}
            onkeydown={(e) => (e.key === "Enter" || e.key === " ") && select(wt)}
          >
            <span
              class="dot"
              class:on={$sessionStatus[wt.path] === "ready" || $sessionStatus[wt.path] === "busy"}
              class:busy={$sessionStatus[wt.path] === "busy"}
            ></span>
            {#if wt.is_main}
              <House class="wt-home" />
            {/if}
            <span class="wt-name">{wt.branch ?? "(detached)"}</span>
            {#if $pendingPermission[wt.path]}
              <span class="wt-pending" title="Waiting for permission">!</span>
            {/if}
            {#if ($unreadByWorktree[wt.path] ?? 0) > 0 && $selectedWorktree !== wt.path}
              <span class="wt-unread" title="Finished while in background">{$unreadByWorktree[wt.path]}</span>
            {/if}
            {#if !wt.is_main}
              <Button
                variant="ghost"
                size="icon-xs"
                class="opacity-0 transition-opacity group-hover/row:opacity-100"
                title="Remove worktree"
                onclick={(e: Event) => remove(repo.path, wt, e)}
              >×</Button>
            {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  {#if $repos.length === 0}
    <div class="wt-empty">No projects yet — add a repository above.</div>
  {/if}

  {#if error}<div class="error-box">{error}</div>{/if}
</div>
