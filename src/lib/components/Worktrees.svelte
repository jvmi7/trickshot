<script lang="ts">
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
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
    removeScriptRun,
    centerView,
    setCenterView,
    setMainView,
    unreadByWorktree,
    clearUnread,
    forgetChats,
    archivedWorkspaces,
    addArchived,
    restoreWorkspace,
    gitStatByWorktree,
    homePath,
    repoIconByRepo,
    loadRepoIcon,
    type ArchivedWorkspace,
  } from "../stores";
  import * as api from "../api";
  import { generateWorktreeName } from "../branchNames";
  import { slidingRowHighlight } from "../slidingHighlight";
  import { toastMessage } from "../toast";
  import { disposeTerminal } from "../terminal";
  import { profileAccent } from "../termProfiles";
  import { basename } from "../utils";
  import type { Worktree } from "../types";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import * as ContextMenu from "$lib/components/ui/context-menu";
  import IconButton from "./IconButton.svelte";
  import IdentityGlyph from "./IdentityGlyph.svelte";
  import TrickshotMark from "./TrickshotMark.svelte";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Archive from "@lucide/svelte/icons/archive";

  let creatingFor = $state<string | null>(null); // repo path the inline create field is open for
  let collapsed = $state<Record<string, boolean>>({}); // repo paths whose worktree list is folded
  function toggleRepo(path: string) {
    collapsed = { ...collapsed, [path]: !collapsed[path] };
  }
  let newBranch = $state("");
  let creating = $state(false);
  let error = $state("");
  // The ONE confirm Dialog's pending action: archiving a dirty worktree (the
  // force-remove discards uncommitted work), removing a BRANCHLESS worktree
  // (detached HEAD can't archive — remove is its only exit), or retrying an
  // archive whose cleanup script failed. (Deleting an ARCHIVED workspace
  // confirms in ArchivedSection — archived flows live there.)
  type ConfirmAction =
    | { kind: "remove" | "archive"; repoPath: string; wt: Worktree; fileCount: number }
    | { kind: "archive-skip-hook"; repoPath: string; wt: Worktree; scriptError: string };
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

  // The Home row: lands on the HOME SCREEN (hero + composer + fleet) — the
  // exact state closing a worktree leaves you in (deselected), so "Home"
  // means ONE place. (It previously opened a chat rooted at ~; the Home
  // screen replaced that meaning when it became a real destination.)
  function selectHome() {
    selectWorktree(null);
    setCenterView("chat");
    setMainView("chat"); // the run view outranks no-selection in the cascade
  }

  // Repo favicons: probe each repo once per app run (idempotent in the store).
  $effect(() => {
    for (const r of $repos) loadRepoIcon(r.path);
  });

  // ⌘⇧N / the palette / the fleet ask for a new worktree via this nonce:
  // instantly create one (auto-named) for the selected worktree's repo (or the
  // first repo) — no naming prompt on the fast path.
  let lastCreateReq = $state(0);
  $effect(() => {
    const req = $newWorktreeRequest;
    if (req === lastCreateReq) return;
    lastCreateReq = req;
    const target =
      $repos.find((r) => ($worktreesByRepo[r.path] ?? []).some((w) => w.path === $selectedWorktree))
        ?.path ?? $repos[0]?.path;
    if (target) void createAuto(target);
  });

  async function startCreate(repoPath: string) {
    creatingFor = repoPath;
    newBranch = "";
    await tick();
    branchInput?.focus();
  }

  // The ONE create path: makes the worktree, selects it, and fires the repo's
  // setup script. The manual input and the auto-name flow both land here.
  async function createWith(repoPath: string, branch: string) {
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

  function create(repoPath: string) {
    return createWith(repoPath, newBranch.trim());
  }

  // One-click create: a generated friendly name, no prompt (the default path —
  // ⌥-click the + for the manual input). Collision set = this repo's worktree
  // branches + its archived branches; an unknown plain-git branch colliding is
  // vanishingly rare (1600 pairs) and harmlessly checks that branch out.
  function createAuto(repoPath: string) {
    const taken = new Set<string>();
    for (const w of $worktreesByRepo[repoPath] ?? []) if (w.branch) taken.add(w.branch);
    for (const a of $archivedWorkspaces) if (a.repoPath === repoPath) taken.add(a.branch);
    return createWith(repoPath, generateWorktreeName(taken));
  }

  // Begin archival — the ONE verb on a live workspace; permanent deletion
  // exists only on the Archived list (archive → purge). Archive of a CLEAN
  // tree proceeds immediately but gets an Undo toast (restore is lossless); a
  // dirty tree confirms first (the force-remove discards uncommitted work).
  // "remove" survives ONLY as the branchless fallback: a detached-HEAD
  // worktree can't archive (restore needs a branch), so its row keeps a
  // direct remove — which ALWAYS confirms (it drops the chat for good).
  // NOTE: `e` takes an explicit default, not a `?:` optional — Svelte's TS
  // stripper leaves the bare `e?` in the output, which JavaScriptCore rejects
  // as a syntax error.
  async function requestAction(
    kind: "remove" | "archive",
    repoPath: string,
    wt: Worktree,
    e: Event | null = null,
  ) {
    e?.stopPropagation();
    error = "";
    let fileCount = 0;
    try {
      fileCount = (await api.worktreeStatus(wt.path)).files.length;
    } catch {
      // status check failed (e.g. not a git dir) — treat as clean
    }
    if (kind === "remove" || fileCount > 0) {
      confirmAction = { kind, repoPath, wt, fileCount };
      return;
    }
    await doArchive(repoPath, wt);
  }

  // Force-remove the worktree and drop all of its local state.
  async function doRemove(repoPath: string, wt: Worktree) {
    error = "";
    try {
      await api.stopScript(wt.path);
      disposeTerminal(wt.path);
      await api.removeWorktree(repoPath, wt.path, true);
      clearStatus(wt.path);
      forgetChats(wt.path);
      removeScriptRun(wt.path);
      removeWorktreeFromRepo(repoPath, wt.path);
      if ($selectedWorktree === wt.path) selectWorktree(null);
    } catch (err) {
      error = String(err);
    }
  }

  // Archive: remove the worktree DIR (branch kept). Claude Code's own session
  // store is keyed by the worktree path, so restoring the branch recreates the
  // same path and the conversation resumes on restore (see stores.ts ›
  // archivedWorkspaces). The repo's archive script (if any) runs to completion
  // FIRST, while the worktree still exists.
  async function doArchive(repoPath: string, wt: Worktree, skipHook = false) {
    error = "";
    if (!wt.branch) return; // restore needs a branch; detached HEAD can't archive
    try {
      let archiveCmd: string | null = null;
      if (!skipHook) {
        try {
          archiveCmd = (await api.getScripts(repoPath)).archive;
        } catch {
          // unreadable settings file — archive proceeds without a hook
        }
      }
      // A failing archive script must not dead-end the flow: archive is the
      // only exit for a branched workspace, so offer "archive anyway" (the
      // hook exists to clean up resources — the user decides whether leaking
      // them beats being stuck with an unarchivable workspace).
      if (archiveCmd) {
        try {
          await api.runScriptBlocking(repoPath, wt.path, "archive");
        } catch (err) {
          confirmAction = { kind: "archive-skip-hook", repoPath, wt, scriptError: String(err) };
          return;
        }
      }
      await api.stopScript(wt.path);
      disposeTerminal(wt.path);
      await api.removeWorktree(repoPath, wt.path, true);
      clearStatus(wt.path);
      removeScriptRun(wt.path);
      removeWorktreeFromRepo(repoPath, wt.path);
      const entry: ArchivedWorkspace = {
        repoPath,
        repoName: basename(repoPath),
        branch: wt.branch,
        path: wt.path,
        archivedAt: Date.now(),
      };
      addArchived(entry);
      if ($selectedWorktree === wt.path) selectWorktree(null);
      // Archiving is lossless (restore revives chat + context) — offer the
      // instant round-trip instead of making the action feel scary.
      toastMessage(`Archived ${wt.branch}`, {
        action: { label: "Undo", onClick: () => void restoreWorkspace(entry).catch(() => {}) },
      });
    } catch (err) {
      error = String(err);
    }
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
    if (c.kind === "archive-skip-hook") doArchive(c.repoPath, c.wt, true);
    else if (c.kind === "archive") doArchive(c.repoPath, c.wt);
    else doRemove(c.repoPath, c.wt);
  }
</script>

<!-- slidingRowHighlight is applied PER .wt-rows block (not once on the root)
     so the hover/active fill only slides between rows of the SAME repository —
     crossing into another group fades out/in instead of gliding over headers. -->
<div class="wt">
  <!-- Home: THE Home screen (hero + composer + fleet) — the same place
       closing a worktree lands (deselected). Active whenever nothing is
       selected and the center pane isn't Settings. -->
  {#if $homePath}
    <div class="wt-rows home-rows" use:slidingRowHighlight>
      <div
        class="wt-row"
        class:active={$selectedWorktree === null && $centerView !== "settings"}
        role="button"
        tabindex="0"
        onclick={selectHome}
        onkeydown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectHome();
          }
        }}
      >
        <TrickshotMark class="wt-home" />
        <span class="wt-name">trickshot</span>
      </div>
    </div>
  {/if}

  <div class="wt-section section-label">
    <span>Repositories</span>
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
                {#if $repoIconByRepo[repo.path]}
                  <img class="repo-favicon" src={$repoIconByRepo[repo.path]} alt="" />
                {:else}
                  <FolderGit2 class="repo-favicon" />
                {/if}
                <span class="repo-name section-label">{repo.name}</span>
              </button>
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props })}
                    <IconButton
                      {...props}
                      class="opacity-0 group-hover/repo:opacity-100"
                      aria-label="New worktree"
                      onclick={(e: MouseEvent) =>
                        e.altKey ? startCreate(repo.path) : void createAuto(repo.path)}
                    >
                      <Plus />
                    </IconButton>
                  {/snippet}
                </Tooltip.Trigger>
                <Tooltip.Content>New worktree — auto-named (⌥-click to name it)</Tooltip.Content>
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
        <!-- transition:slide = the smooth accordion height (JS-driven, so no
             fixed-height CSS hacks; params exempt from the CSS duration scan). -->
        <div transition:slide={{ duration: 220, easing: cubicOut }}>
        {#if creatingFor === repo.path}
          <!-- No blur-to-cancel: a stray click (or the OS dialog stealing focus)
               must not discard a half-typed name. Esc cancels; Enter creates. -->
          <Input
            class="my-1"
            placeholder="branch name…  (Enter, Esc cancels)"
            bind:value={newBranch}
            bind:ref={branchInput}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === "Enter") create(repo.path);
              else if (e.key === "Escape") creatingFor = null;
            }}
          />
        {/if}

        <div class="wt-rows" use:slidingRowHighlight>
          {#each $worktreesByRepo[repo.path] ?? [] as wt (wt.path)}
          <!-- busy also drives the row class: a greyed glyph must color back in
               while its session's loading morph plays (see app.css). -->
          {@const busy = $sessionStatus[wt.path] === "busy"}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              {#snippet child({ props })}
                <div
                  {...props}
                  class="wt-row group/row"
                  class:active={$selectedWorktree === wt.path}
                  class:busy
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
                  <IdentityGlyph seed={wt.path} color={profileAccent(wt.path)} loading={busy} />
                  <span class="wt-name">{wt.branch ?? "(detached)"}</span>
                  {#if ($gitStatByWorktree[wt.path]?.changed ?? 0) > 0}
                    {@const gs = $gitStatByWorktree[wt.path]}
                    <span class="wt-stat" title="{gs?.changed} changed file{gs?.changed === 1 ? '' : 's'}">
                      {#if gs?.insertions}<span class="diff-add">+{gs.insertions}</span>{/if}
                      {#if gs?.deletions}<span class="diff-del">−{gs.deletions}</span>{/if}
                      {#if !gs?.insertions && !gs?.deletions}<span class="diff-add">●</span>{/if}
                    </span>
                  {/if}
                  {#if ($unreadByWorktree[wt.path] ?? 0) > 0 && $selectedWorktree !== wt.path}
                    <span class="wt-unread" title="Finished while in background">{$unreadByWorktree[wt.path]}</span>
                  {/if}
                  <!-- Archive is the ONE verb on a live workspace (delete lives on
                       the Archived list). The trash fallback exists only for a
                       BRANCHLESS (detached HEAD) worktree, which can't archive. -->
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
                    {:else}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        class="opacity-0 transition-opacity group-hover/row:opacity-100"
                        title="Remove worktree (detached — can't archive; discards its working files)"
                        aria-label="Remove worktree"
                        onclick={(e: Event) => requestAction("remove", repo.path, wt, e)}
                      >
                        <Trash2 class="size-3" />
                      </Button>
                    {/if}
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
                {:else}
                  <ContextMenu.Item
                    variant="destructive"
                    onclick={() => requestAction("remove", repo.path, wt)}
                  >
                    <Trash2 class="size-3.5" />
                    Remove worktree
                  </ContextMenu.Item>
                {/if}
              </ContextMenu.Content>
            {/if}
          </ContextMenu.Root>
          {/each}
        </div>
        </div>
      {/if}
    </div>
  {/each}

  {#if $repos.length === 0}
    <div class="wt-empty">No repositories yet — add one above.</div>
  {/if}

  <!-- mt-[16px]: the old .error-box margin, kept at its one call site (spacing is per-site). -->
  {#if error}<div class="error-text mt-[16px]">{error}</div>{/if}
</div>

<Dialog.Root open={!!confirmAction} onOpenChange={(open) => !open && (confirmAction = null)}>
  <Dialog.Content>
    <Dialog.Header>
      {#if confirmAction?.kind === "archive-skip-hook"}
        <Dialog.Title>Archive script failed</Dialog.Title>
        <Dialog.Description>
          The repo's archive cleanup script failed on "{confirmAction.wt.branch ??
            confirmAction.wt.path}": {confirmAction.scriptError} — archive anyway? Resources the
          script would have cleaned up may be left behind.
        </Dialog.Description>
      {:else if confirmAction && confirmAction.fileCount > 0}
        <Dialog.Title>{confirmAction.kind === "archive" ? "Archive" : "Remove"} worktree?</Dialog.Title>
        <Dialog.Description>
          "{confirmAction.wt.branch ?? confirmAction.wt.path}" has {confirmAction.fileCount} uncommitted
          change{confirmAction.fileCount === 1 ? "" : "s"}. {confirmAction.kind === "archive"
            ? "Archiving removes the working files and discards them (commit first to keep them); the chat is kept for restore."
            : "Removing discards them."}
        </Dialog.Description>
      {:else if confirmAction}
        <!-- Clean-tree remove — only reachable for a BRANCHLESS (detached HEAD)
             worktree, the one kind that can't archive. Still deserves a stop:
             the worktree disappears for good. -->
        <Dialog.Title>Remove worktree?</Dialog.Title>
        <Dialog.Description>
          "{confirmAction.wt.branch ?? confirmAction.wt.path}" has no branch (detached HEAD), so it
          can't be archived — removing drops the worktree for good.
        </Dialog.Description>
      {/if}
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => (confirmAction = null)}>Cancel</Button>
      <Button variant="destructive" onclick={confirmProceed}>
        {confirmAction?.kind === "archive"
          ? "Archive"
          : confirmAction?.kind === "archive-skip-hook"
            ? "Archive anyway"
            : "Remove"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
