<script lang="ts">
  import { tick } from "svelte";
  import { get } from "svelte/store";
  import {
    repos,
    worktreesByRepo,
    selectedWorktree,
    sessionStatus,
    resetTranscript,
    sessionByWorktree,
    forgetWorktreeSession,
    setCenterView,
    permissionModeByWorktree,
    DEFAULT_PERMISSION_MODE,
    systemPromptAppend,
    getMcpServers,
    getAgents,
    unreadByWorktree,
    clearUnread,
    pendingPermission,
  } from "../stores";
  import * as api from "../api";
  import type { Worktree } from "../types";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import House from "@lucide/svelte/icons/house";

  let creatingFor: string | null = null; // repo path the inline create field is open for
  let newBranch = "";
  let creating = false;
  let error = "";
  // null (not undefined): Input's `ref` is $bindable(null); Svelte throws on
  // bind:ref={undefined} when the bindable has a fallback value.
  let branchInput: HTMLInputElement | null = null;

  function repoName(path: string): string {
    return path.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() || path;
  }

  function pruneStatus(paths: string[]) {
    sessionStatus.update((s) => {
      const next = { ...s };
      for (const p of paths) delete next[p];
      return next;
    });
  }

  async function addRepo() {
    error = "";
    try {
      const p = await api.pickDirectory();
      if (!p) return;
      repos.update((rs) => (rs.some((r) => r.path === p) ? rs : [...rs, { path: p, name: repoName(p) }]));
      await refresh(p);
    } catch (e) {
      error = String(e);
    }
  }

  async function refresh(repoPath: string) {
    try {
      const wts = await api.listWorktrees(repoPath);
      worktreesByRepo.update((m) => ({ ...m, [repoPath]: wts }));
    } catch (e) {
      error = String(e);
    }
  }

  async function removeRepo(repoPath: string) {
    const wts = $worktreesByRepo[repoPath] ?? [];
    for (const wt of wts) {
      try {
        await api.stopSession(wt.path);
      } catch {
        /* ignore */
      }
      resetTranscript(wt.path);
      forgetWorktreeSession(wt.path);
    }
    const paths = wts.map((w) => w.path);
    if ($selectedWorktree && paths.includes($selectedWorktree)) selectedWorktree.set(null);
    pruneStatus(paths);
    repos.update((rs) => rs.filter((r) => r.path !== repoPath));
    worktreesByRepo.update((m) => {
      const next = { ...m };
      delete next[repoPath];
      return next;
    });
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
      await api.startSession(wt.path, {
        resume: get(sessionByWorktree)[wt.path],
        permissionMode: get(permissionModeByWorktree)[wt.path] ?? DEFAULT_PERMISSION_MODE,
        systemPromptAppend: get(systemPromptAppend),
        mcpServers: getMcpServers(),
        agents: getAgents(),
      });
      sessionStatus.update((s) => ({ ...s, [wt.path]: "ready" }));
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
      worktreesByRepo.update((m) => ({ ...m, [repoPath]: [...(m[repoPath] ?? []), wt] }));
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
      pruneStatus([wt.path]);
      worktreesByRepo.update((m) => ({
        ...m,
        [repoPath]: (m[repoPath] ?? []).filter((w) => w.path !== wt.path),
      }));
      if ($selectedWorktree === wt.path) selectedWorktree.set(null);
    } catch (err) {
      error = String(err);
    }
  }
</script>

<div class="wt">
  {#each $repos as repo (repo.path)}
    <div class="repo-group">
      <div class="repo-head">
        <span class="repo-name" title={repo.path}>{repo.name}</span>
        <div class="repo-actions">
          <Button variant="ghost" size="icon-sm" title="New worktree" onclick={() => startCreate(repo.path)}>+</Button>
          <Button variant="ghost" size="icon-sm" title="Remove repository from sidebar" onclick={() => removeRepo(repo.path)}>−</Button>
        </div>
      </div>

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
            on:click={() => select(wt)}
            on:keydown={(e) => (e.key === "Enter" || e.key === " ") && select(wt)}
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
    </div>
  {/each}

  <Button variant="outline" class="mt-1 w-full" onclick={addRepo}>+ Add repository</Button>

  {#if error}<div class="error-box">{error}</div>{/if}
</div>
