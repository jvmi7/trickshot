<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { onScriptEvent, onTermEvent, listWorktrees, worktreeStatus, homeDir } from "./lib/api";
  import { borderGlow } from "./lib/borderGlow";
  import { handleTermEvent } from "./lib/terminal";
  import {
    repos,
    worktreesByRepo,
    setWorktrees,
    selectedWorktree,
    selectWorktree,
    sidebarOpen,
    toggleSidebar,
    sidebarWidth,
    setSidebarWidth,
    centerView,
    setCenterView,
    refreshUsage,
    authState,
    refreshAuth,
    mainView,
    setMainView,
    toggleMainView,
    gitRefreshNonce,
    setGitStat,
    activeGitStat,
    activeScriptRun,
    activeRepo,
    changesOpen,
    setChangesOpen,
    toggleChanges,
    shellOpen,
    setShellOpen,
    activateWorktree,
    homePath,
    toggleCommandPalette,
    toggleCompose,
    toggleShortcutsHelp,
    requestNewWorktree,
  } from "./lib/stores";
  import { handleScriptEvent } from "./lib/scriptEvents";
  import ClaudeTerminalPane from "./lib/components/ClaudeTerminalPane.svelte";
  import ChatTabs from "./lib/components/ChatTabs.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import Header from "./lib/components/Header.svelte";
  import ViewToggle from "./lib/components/ViewToggle.svelte";
  import RunScripts from "./lib/components/RunScripts.svelte";
  import RunOutput from "./lib/components/RunOutput.svelte";
  import Worktrees from "./lib/components/Worktrees.svelte";
  import ArchivedSection from "./lib/components/ArchivedSection.svelte";
  import Fleet from "./lib/components/Fleet.svelte";
  import Settings from "./lib/components/Settings.svelte";
  import Welcome from "./lib/components/Welcome.svelte";
  import ComposeDialog from "./lib/components/ComposeDialog.svelte";
  import ShortcutsHelp from "./lib/components/ShortcutsHelp.svelte";
  import UsageIndicator from "./lib/components/UsageIndicator.svelte";
  import { Button } from "./lib/components/ui/button";
  import { Toaster } from "./lib/components/ui/sonner";
  import * as Tooltip from "./lib/components/ui/tooltip";
  import { basename } from "./lib/utils";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import ArrowLeftToLine from "@lucide/svelte/icons/arrow-left-to-line";
  import ArrowRightFromLine from "@lucide/svelte/icons/arrow-right-from-line";

  // Header breadcrumb: `repo / branch` reads better than the raw absolute path
  // (which survives as the tooltip). Branch comes from the worktree list.
  const activeBranch = $derived.by(() => {
    const sel = $selectedWorktree;
    if (!sel) return null;
    for (const list of Object.values($worktreesByRepo)) {
      const w = list.find((x) => x.path === sel);
      if (w) return w.branch ?? "(detached)";
    }
    return null;
  });

  // Re-probe the login when the window regains focus, but only while the
  // sign-in notice is showing — this is the "cmd-tab to a terminal, run
  // `claude`, cmd-tab back" round trip clearing itself. Never on a normal
  // focus (the macOS check shells out to `security`).
  function onWindowFocus() {
    if (get(authState) === "missing") void refreshAuth();
  }

  // Global shortcuts (Conductor parity): ⌘K palette, ⌘⇧N new worktree,
  // ⌘⇧D changes/diff view, ⌘⇧P the PR block (same Changes panel), ⌘, settings,
  // ⌘1–9 jump to the Nth worktree (sidebar order). Esc leaves Settings. All
  // ⌘-chords guard on meta/ctrl so typing stays unaffected (macOS ⌘-chords
  // never reach the PTY through xterm, so nothing is stolen from the TUI).
  function onKeydown(e: KeyboardEvent) {
    // Esc: leave Settings — unless something else (a dialog, the palette)
    // already handled it (bits-ui prevents default when it consumes Esc).
    if (e.key === "Escape" && !e.defaultPrevented && get(centerView) === "settings") {
      setCenterView("chat");
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (!e.shiftKey && k === "/") {
      e.preventDefault();
      toggleShortcutsHelp();
    } else if (!e.shiftKey && k === "e") {
      // Compose popup: a full editor for long prompts (needs a chat to send to).
      if (get(selectedWorktree)) {
        e.preventDefault();
        setCenterView("chat");
        toggleCompose();
      }
    } else if (!e.shiftKey && k === ",") {
      e.preventDefault();
      setCenterView("settings");
    } else if (!e.shiftKey && k === "k") {
      e.preventDefault();
      toggleCommandPalette();
    } else if (e.shiftKey && k === "n") {
      e.preventDefault();
      requestNewWorktree();
    } else if (e.shiftKey && (k === "d" || k === "p")) {
      e.preventDefault();
      setCenterView("chat");
      toggleChanges();
    } else if (!e.shiftKey && k >= "1" && k <= "9") {
      // Jump to the Nth worktree in sidebar order (repos, then their worktrees).
      const flat = get(repos).flatMap((r) => get(worktreesByRepo)[r.path] ?? []);
      const target = flat[Number(k) - 1];
      if (target) {
        e.preventDefault();
        setCenterView("chat");
        void activateWorktree(target.path).catch(() => {});
      }
    }
  }

  // Drag-to-resize the sidebar: track the pointer from the right-edge handle and
  // feed the new width (clamped in setSidebarWidth) live. `resizing` flips a class
  // that shows the col-resize cursor and suppresses text selection during the drag.
  let resizing = $state(false);
  function startResize(e: PointerEvent) {
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startW = get(sidebarWidth);
    const move = (ev: PointerEvent) => setSidebarWidth(startW + (ev.clientX - startX));
    const up = () => {
      resizing = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Keep every worktree's change summary fresh: the header's Changes tab keys
  // off the SELECTED one, and the sidebar rows show a ± glance per worktree
  // (the fleet view). Re-runs on selection and on gitRefreshNonce (bumped
  // after a turn that likely touched files); each refresh is one `git status`
  // per worktree — cheap at sidebar scale.
  $effect(() => {
    void $selectedWorktree;
    void $gitRefreshNonce;
    const all = $repos.flatMap((r) => $worktreesByRepo[r.path] ?? []);
    for (const w of all) {
      worktreeStatus(w.path)
        .then((s) =>
          setGitStat(w.path, {
            changed: s.files.length,
            insertions: s.insertions,
            deletions: s.deletions,
            aheadOfDefault: s.ahead_of_default,
          }),
        )
        // Non-git dirs / errors → treat as no changes (Worktrees surfaces real errors).
        .catch(() =>
          setGitStat(w.path, { changed: 0, insertions: 0, deletions: 0, aheadOfDefault: 0 }),
        );
    }
  });

  // If the worktree on screen has nothing to review (clean AND not ahead of the
  // default branch), don't strand the user on the (now hidden) Changes tab —
  // fall back to chat. A clean-but-unmerged branch keeps the tab: its PR/checks
  // panel must stay reachable after a commit. Same for the Run tab when the
  // worktree has no script run.
  $effect(() => {
    const gs = $activeGitStat;
    // The Changes POPOVER closes when there's nothing left to review.
    if ($changesOpen && (gs?.changed ?? 0) === 0 && (gs?.aheadOfDefault ?? 0) === 0)
      setChangesOpen(false);
    if ($mainView === "run" && !$activeScriptRun) setMainView("chat");
    if ($shellOpen && !$selectedWorktree) setShellOpen(false);
  });

  onMount(() => {
    let cancelled = false;

    // Populate the subscription-usage chip on launch (throttled thereafter).
    refreshUsage();
    // Probe the provider login for the sign-in notice (local read, silent).
    void refreshAuth();

    // Wire the script-output stream (lib/scriptEvents.ts).
    let unlistenScripts: (() => void) | undefined;
    onScriptEvent(handleScriptEvent)
      .then((u) => {
        if (cancelled) u();
        else unlistenScripts = u;
      })
      .catch(() => {});

    // …and the PTY stream (lib/terminal.ts).
    let unlistenTerm: (() => void) | undefined;
    onTermEvent(handleTermEvent)
      .then((u) => {
        if (cancelled) u();
        else unlistenTerm = u;
      })
      .catch(() => {});

    // Rehydrate worktrees for persisted repos (git is the source of truth),
    // then drop a stale persisted selection that no longer exists on disk.
    (async () => {
      // Resolve the Home workspace root FIRST (serialized, not raced) — the
      // stale-selection guard below must recognize a persisted Home selection.
      homePath.set(await homeDir().catch(() => null));
      for (const repo of get(repos)) {
        try {
          const wts = await listWorktrees(repo.path);
          setWorktrees(repo.path, wts);
        } catch {
          // repo moved/deleted — leave it empty in the sidebar
        }
      }
      // A live selection needs no session start here: ClaudeTerminalPane's
      // mount reopens the claude PTY (resuming the newest session id).
      const sel = get(selectedWorktree);
      if (sel) {
        // Home always "exists" — it's the OS home dir, not a git worktree.
        const exists =
          sel === get(homePath) ||
          Object.values(get(worktreesByRepo)).some((list) => list.some((w) => w.path === sel));
        if (!exists) selectWorktree(null);
      }
    })();

    return () => {
      cancelled = true;
      unlistenScripts?.();
      unlistenTerm?.();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} onfocus={onWindowFocus} />

<Tooltip.Provider delayDuration={100}>
<Toaster position="bottom-right" />
<ShortcutsHelp />
<ComposeDialog />
<CommandPalette />
<div class="layout" class:resizing style="--sidebar-width: {$sidebarWidth}px">
  <aside class="sidebar" class:collapsed={!$sidebarOpen}>
    <!-- empty strip aligning the worktree list's top with the content's top bar
         and clearing the traffic lights + floating toggle; the sidebar's right
         border runs full-height as the only column divider. -->
    <div class="sidebar-head" data-tauri-drag-region></div>
    <div class="sidebar-list"><Worktrees /></div>
    <!-- Archived workspaces: pinned BELOW the scrolling list (its own footer
         band) so a long repo list can't push it off screen. -->
    <ArchivedSection />
    <!-- Opens the full Settings page (appearance + global connectors) in the
         center pane, in place of the chat. -->
    <div class="sidebar-foot">
      <Button
        variant="ghost"
        class="w-full justify-start gap-2 {$centerView === 'settings'
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground'}"
        onclick={() => setCenterView("settings")}
        aria-label="Settings"
      >
        <SettingsIcon class="size-4" />
        Settings
      </Button>
    </div>
    <!-- drag handle straddling the right border; resizes the sidebar width -->
    <div
      class="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onpointerdown={startResize}
    ></div>
  </aside>

  <main class="main">
    <!-- top bar: the workspace path sits inline in the header band. -->
    <Header>
      {#snippet left()}
        <!-- The breadcrumb IS the sidebar toggle (no separate floating button):
             clicking the project/branch label collapses/expands the sidebar. -->
        <button
          type="button"
          class="workspace-label"
          onclick={toggleSidebar}
          aria-label={$sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          title={$sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          <!-- The toggle affordance: collapse-arrow while the sidebar shows,
               expand-arrow while hidden (replaces the ❯ prompt glyph). -->
          {#if $sidebarOpen}
            <ArrowLeftToLine class="ws-toggle size-3.5" />
          {:else}
            <ArrowRightFromLine class="ws-toggle size-3.5" />
          {/if}
          {#if $centerView === "settings"}
            <span class="path">Settings</span>
          {:else if $selectedWorktree && $selectedWorktree === $homePath}
            <!-- The Home workspace (~) is repo-less — "Home" beats a bare "~". -->
            <span class="path" title={$selectedWorktree}>Home</span>
          {:else if $selectedWorktree}
            <!-- The separator lives inside ONE expression — text at element
                 boundaries gets whitespace-collapsed ("kosha/ main"). -->
            <span class="path" title={$selectedWorktree}>
              {$activeRepo ? basename($activeRepo.path) : basename($selectedWorktree)}{#if activeBranch}<span
                  class="dim">{` / ${activeBranch}`}</span
                >{/if}
            </span>
          {:else if $repos.length === 0}
            <span class="dim">add a repository to get started</span>
          {:else}
            <span class="dim">select or create a worktree on the left</span>
          {/if}
        </button>
      {/snippet}
      {#snippet actions()}
        <!-- Hidden on Settings and on the zero-repo welcome — the toggles have
             nothing to act on there. -->
        {#if $centerView !== "settings" && $repos.length > 0}
          <UsageIndicator />
          <RunScripts />
          <ViewToggle />
        {/if}
      {/snippet}
    </Header>
    <!-- The chat-session strip sits on the SHELL band, outside the terminal
         card — shown exactly when the card below renders the chat surface
         (the same cascade conditions as the {:else} branch inside). -->
    {#if $centerView !== "settings" && $repos.length > 0 && $mainView !== "run" && $selectedWorktree}
      <ChatTabs />
    {/if}
    <div class="content" use:borderGlow>
      <div class="content-clip">
      {#if $centerView === "settings"}
        <Settings />
      {:else if $repos.length === 0}
        <!-- First-run (or removed-last-repo) welcome: replaces the whole center
             pane, composer included. Gated on repo count — state, not a flag —
             so it reappears exactly when it's true again. -->
        <Welcome />
      {:else if $mainView === "run"}
        <RunOutput />
      {:else if !$selectedWorktree}
        <!-- No selection + repos exist: the fleet overview (mission control),
             not a dead-end hint. The palette's "Fleet overview" deselects to
             land here. -->
        <Fleet />
      {:else}
        <!-- The chat: the REAL Claude Code TUI on the worktree's claude PTY. -->
        <ClaudeTerminalPane />
      {/if}
      </div>
    </div>
  </main>
</div>
</Tooltip.Provider>
