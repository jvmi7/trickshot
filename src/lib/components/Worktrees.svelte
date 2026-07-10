<script lang="ts">
  import { tick } from "svelte";
  import {
    repos,
    addRepo,
    removeRepo,
    worktreesByRepo,
    openRepository,
    addWorktree,
    removeWorktreeFromRepo,
    selectedWorktree,
    selectWorktree,
    sessionStatus,
    clearStatus,
    activateWorktree,
    newWorktreeRequest,
    resetTranscript,
    forgetWorktreeSession,
    removeComments,
    removeScriptRun,
    setCenterView,
    setMainView,
    unreadByWorktree,
    clearUnread,
    pendingPermission,
    archivedWorkspaces,
    addArchived,
    removeArchived,
    type ArchivedWorkspace,
  } from "../stores";
  import * as api from "../api";
  import { disposeTerminal } from "../terminal";
  import { basename } from "../utils";
  import type { Worktree } from "../types";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import * as ContextMenu from "$lib/components/ui/context-menu";
  import IconButton from "./IconButton.svelte";
  import House from "@lucide/svelte/icons/house";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Archive from "@lucide/svelte/icons/archive";
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";

  let creatingFor = $state<string | null>(null); // repo path the inline create field is open for
  let collapsed = $state<Record<string, boolean>>({}); // repo paths whose worktree list is folded
  function toggleRepo(path: string) {
    collapsed = { ...collapsed, [path]: !collapsed[path] };
  }
  let newBranch = $state("");
  let creating = $state(false);
  let error = $state("");
  // The ONE confirm Dialog's pending action: removing/archiving a dirty worktree
  // (both force-remove the dir, discarding uncommitted work) or permanently
  // deleting an archived workspace (drops its chat history).
  type ConfirmAction =
    | { kind: "remove" | "archive"; repoPath: string; wt: Worktree; fileCount: number }
    | { kind: "purge"; entry: ArchivedWorkspace };
  let confirmAction = $state<ConfirmAction | null>(null);
  // null (not undefined): Input's `ref` is $bindable(null); Svelte throws on
  // bind:ref={undefined} when the bindable has a fallback value.
  let branchInput = $state<HTMLInputElement | null>(null);

  // Shared add-repo flow (stores.openRepository): validates before persisting
  // and lands the user in the main worktree's chat. This just owns the
  // sidebar's local error surface, mirroring select().
  async function pickAndAddRepo() {
    error = "";
    try {
      await openRepository();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Selecting a worktree = activating its session (no manual start/stop) and
  // returning the center pane to the chat. The shared `activateWorktree` does
  // the work (the command palette uses the same path); this just owns the
  // sidebar's local error surface.
  async function select(wt: Worktree) {
    try {
      await activateWorktree(wt.path);
    } catch (e) {
      error = String(e);
    }
  }

  // ⌘⇧N / the palette ask for a new worktree via this nonce: open the inline
  // create field for the selected worktree's repo (or the first repo).
  let lastCreateReq = $state(0);
  $effect(() => {
    const req = $newWorktreeRequest;
    if (req === lastCreateReq) return;
    lastCreateReq = req;
    const target =
      $repos.find((r) => ($worktreesByRepo[r.path] ?? []).some((w) => w.path === $selectedWorktree))
        ?.path ?? $repos[0]?.path;
    if (target) startCreate(target);
  });

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
      // Conductor-style setup script: a fresh worktree only has git-tracked
      // files, so the repo's `.trickshot/settings.json` setup script installs
      // deps / copies .env etc. Fire-and-forget — output lands in the Run tab.
      try {
        const scripts = await api.getScripts(repoPath);
        if (scripts.setup) {
          await api.runScript(repoPath, wt.path, "setup");
          setMainView("run");
        }
      } catch {
        // no/invalid settings file — a new worktree simply starts cold
      }
    } catch (e) {
      error = String(e);
    } finally {
      creating = false;
    }
  }

  // Begin removal/archival: if the worktree has uncommitted work, open the
  // confirm Dialog first (both force-remove the dir, which discards it);
  // otherwise proceed straight away. NOTE: `e` takes an explicit default, not
  // a `?:` optional — Svelte's TS stripper leaves the bare `e?` in the output,
  // which JavaScriptCore (the Tauri webview) rejects as a syntax error.
  async function requestAction(
    kind: "remove" | "archive",
    repoPath: string,
    wt: Worktree,
    e: Event | null = null,
  ) {
    e?.stopPropagation();
    error = "";
    try {
      const st = await api.worktreeStatus(wt.path);
      if (st.files.length > 0) {
        confirmAction = { kind, repoPath, wt, fileCount: st.files.length };
        return;
      }
    } catch {
      // status check failed (e.g. not a git dir) — proceed
    }
    await (kind === "archive" ? doArchive(repoPath, wt) : doRemove(repoPath, wt));
  }

  // Force-remove the worktree and drop all of its local state.
  async function doRemove(repoPath: string, wt: Worktree) {
    error = "";
    try {
      await api.stopSession(wt.path);
      await api.stopScript(wt.path);
      disposeTerminal(wt.path);
      await api.removeWorktree(repoPath, wt.path, true);
      resetTranscript(wt.path);
      forgetWorktreeSession(wt.path);
      removeComments(wt.path);
      clearStatus(wt.path);
      removeScriptRun(wt.path);
      removeWorktreeFromRepo(repoPath, wt.path);
      if ($selectedWorktree === wt.path) selectWorktree(null);
    } catch (err) {
      error = String(err);
    }
  }

  // Archive: remove the worktree DIR (branch kept) but KEEP its persisted
  // transcript / session id / comments — restoring the branch recreates the
  // same worktree path, so the chat and agent context come back on restore
  // (see stores.ts › archivedWorkspaces). The repo's archive script (if any)
  // runs to completion FIRST, while the worktree still exists.
  async function doArchive(repoPath: string, wt: Worktree) {
    error = "";
    if (!wt.branch) return; // restore needs a branch; detached HEAD can't archive
    try {
      let archiveCmd: string | null = null;
      try {
        archiveCmd = (await api.getScripts(repoPath)).archive;
      } catch {
        // unreadable settings file — archive proceeds without a hook
      }
      // A failing archive script ABORTS the archive (it exists to clean up
      // resources; deleting the dir anyway would leak them).
      if (archiveCmd) await api.runScriptBlocking(repoPath, wt.path, "archive");
      await api.stopSession(wt.path);
      await api.stopScript(wt.path);
      disposeTerminal(wt.path);
      await api.removeWorktree(repoPath, wt.path, true);
      clearStatus(wt.path);
      removeScriptRun(wt.path);
      removeWorktreeFromRepo(repoPath, wt.path);
      addArchived({
        repoPath,
        repoName: basename(repoPath),
        branch: wt.branch,
        path: wt.path,
        archivedAt: Date.now(),
      });
      if ($selectedWorktree === wt.path) selectWorktree(null);
    } catch (err) {
      error = String(err);
    }
  }

  // Restore an archived workspace: recreate the worktree from its branch (same
  // deterministic path → same transcript/session keys) and select it. Re-adds
  // the repo to the sidebar if it was removed meanwhile (addRepo dedupes).
  async function restoreArchived(entry: ArchivedWorkspace) {
    error = "";
    try {
      const wt = await api.createWorktree(entry.repoPath, entry.branch);
      addRepo({ path: entry.repoPath, name: entry.repoName });
      addWorktree(entry.repoPath, wt);
      removeArchived(entry.repoPath, entry.branch);
      await select(wt);
    } catch (e) {
      error = String(e);
    }
  }

  // Permanently delete an archived workspace: purge the persisted chat/session
  // state its restore would have revived, then drop the index entry.
  function purgeArchived(entry: ArchivedWorkspace) {
    resetTranscript(entry.path);
    forgetWorktreeSession(entry.path);
    removeComments(entry.path);
    removeArchived(entry.repoPath, entry.branch);
  }

  // Remove a repo from the sidebar: dispose its worktrees' terminals here
  // (stores.ts must stay free of the xterm module — see lib/terminal.ts), then
  // hand off to the store's removeRepo for the session/state teardown.
  function removeRepoLocal(repoPath: string) {
    for (const wt of $worktreesByRepo[repoPath] ?? []) disposeTerminal(wt.path);
    removeRepo(repoPath);
  }

  // The confirm Dialog's OK: run whichever action was pending.
  function confirmProceed() {
    const c = confirmAction;
    confirmAction = null;
    if (!c) return;
    if (c.kind === "purge") purgeArchived(c.entry);
    else if (c.kind === "archive") doArchive(c.repoPath, c.wt);
    else doRemove(c.repoPath, c.wt);
  }
</script>

<div class="wt">
  <div class="wt-section section-label">
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
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <div {...props} class="repo-head">
              <button
                class="repo-toggle"
                title={repo.path}
                aria-expanded={!collapsed[repo.path]}
                onclick={() => toggleRepo(repo.path)}
              >
                <span class="repo-chevron" class:collapsed={collapsed[repo.path]}><ChevronDown class="size-3.5" /></span>
                <span class="repo-name section-label">{repo.name}</span>
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
          {/snippet}
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item variant="destructive" onclick={() => removeRepoLocal(repo.path)}>
            <Trash2 class="size-3.5" />
            Remove from trickshot
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>

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
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              {#snippet child({ props })}
                <div
                  {...props}
                  class="wt-row group/row"
                  class:active={$selectedWorktree === wt.path}
                  role="button"
                  tabindex="0"
                  onclick={() => select(wt)}
                  onkeydown={(e) => {
                    // Only act on keys aimed at the row itself — Enter/Space on the
                    // nested action Buttons bubbles here and would select the row.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      select(wt);
                    }
                  }}
                >
                  <span
                    class="dot"
                    class:on={$sessionStatus[wt.path] === "ready" ||
                      $sessionStatus[wt.path] === "busy" ||
                      $sessionStatus[wt.path] === "starting"}
                    class:busy={$sessionStatus[wt.path] === "busy" ||
                      $sessionStatus[wt.path] === "starting"}
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
                    {#if wt.branch}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        class="opacity-0 transition-opacity group-hover/row:opacity-100"
                        title="Archive workspace (keeps chat, removes files)"
                        onclick={(e: Event) => requestAction("archive", repo.path, wt, e)}
                      >
                        <Archive class="size-3" />
                      </Button>
                    {/if}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      class="opacity-0 transition-opacity group-hover/row:opacity-100"
                      title="Remove worktree"
                      onclick={(e: Event) => requestAction("remove", repo.path, wt, e)}
                    >×</Button>
                  {/if}
                </div>
              {/snippet}
            </ContextMenu.Trigger>
            {#if !wt.is_main}
              <ContextMenu.Content>
                {#if wt.branch}
                  <ContextMenu.Item onclick={() => requestAction("archive", repo.path, wt)}>
                    <Archive class="size-3.5" />
                    Archive workspace
                  </ContextMenu.Item>
                {/if}
                <ContextMenu.Item
                  variant="destructive"
                  onclick={() => requestAction("remove", repo.path, wt)}
                >
                  <Trash2 class="size-3.5" />
                  Remove worktree
                </ContextMenu.Item>
              </ContextMenu.Content>
            {/if}
          </ContextMenu.Root>
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  {#if $repos.length === 0}
    <div class="wt-empty">No projects yet — add a repository above.</div>
  {/if}

  {#if $archivedWorkspaces.length > 0}
    <div class="wt-section section-label archived-head">
      <span>Archived</span>
    </div>
    <div class="wt-rows">
      {#each $archivedWorkspaces as a (a.repoPath + " " + a.branch)}
        <div class="wt-row group/row archived-row">
          <Archive class="wt-home" />
          <span class="wt-name" title="{a.repoName} · {a.branch}">{a.repoName} / {a.branch}</span>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  variant="ghost"
                  size="icon-xs"
                  class="opacity-0 transition-opacity group-hover/row:opacity-100"
                  aria-label="Restore workspace"
                  onclick={() => restoreArchived(a)}
                >
                  <ArchiveRestore class="size-3" />
                </Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>Restore (recreates the worktree, chat resumes)</Tooltip.Content>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  variant="ghost"
                  size="icon-xs"
                  class="opacity-0 transition-opacity group-hover/row:opacity-100"
                  aria-label="Delete permanently"
                  onclick={() => (confirmAction = { kind: "purge", entry: a })}
                >
                  <Trash2 class="size-3" />
                </Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>Delete permanently (drops its chat history)</Tooltip.Content>
          </Tooltip.Root>
        </div>
      {/each}
    </div>
  {/if}

  <!-- mt-[16px]: the old .error-box margin, kept at its one call site (spacing is per-site). -->
  {#if error}<div class="error-text mt-[16px]">{error}</div>{/if}
</div>

<Dialog.Root open={!!confirmAction} onOpenChange={(open) => !open && (confirmAction = null)}>
  <Dialog.Content>
    <Dialog.Header>
      {#if confirmAction?.kind === "purge"}
        <Dialog.Title>Delete archived workspace?</Dialog.Title>
        <Dialog.Description>
          "{confirmAction.entry.repoName} / {confirmAction.entry.branch}" will be gone for good —
          its chat history is deleted (the git branch is kept).
        </Dialog.Description>
      {:else if confirmAction}
        <Dialog.Title>{confirmAction.kind === "archive" ? "Archive" : "Remove"} worktree?</Dialog.Title>
        <Dialog.Description>
          "{confirmAction.wt.branch ?? confirmAction.wt.path}" has {confirmAction.fileCount} uncommitted
          change{confirmAction.fileCount === 1 ? "" : "s"}. {confirmAction.kind === "archive"
            ? "Archiving removes the working files and discards them (commit first to keep them); the chat is kept for restore."
            : "Removing discards them."}
        </Dialog.Description>
      {/if}
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => (confirmAction = null)}>Cancel</Button>
      <Button variant="destructive" onclick={confirmProceed}>
        {confirmAction?.kind === "archive" ? "Archive" : confirmAction?.kind === "purge" ? "Delete" : "Remove"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
