<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { onAgentEvent, onScriptEvent, onTermEvent, listWorktrees, worktreeStatus } from "./lib/api";
  import { handleTermEvent } from "./lib/terminal";
  import { providerDisplay } from "./lib/providers";
  import {
    activeChatMode,
    activeProvider,
    CHAT_SURFACE,
    chatModeByWorktree,
    setChatMode,
    repos,
    worktreesByRepo,
    setWorktrees,
    selectedWorktree,
    selectWorktree,
    setStatus,
    sidebarOpen,
    toggleSidebar,
    sidebarWidth,
    setSidebarWidth,
    centerView,
    setCenterView,
    refreshUsage,
    bumpGitRefresh,
    authState,
    refreshAuth,
    ensureSession,
    mainView,
    setMainView,
    toggleMainView,
    gitRefreshNonce,
    setGitStat,
    activeGitStat,
    activeScriptRun,
    toggleCommandPalette,
    requestNewWorktree,
  } from "./lib/stores";
  import { handleAgentEvent, handleSessionStatus } from "./lib/agentEvents";
  import { handleScriptEvent } from "./lib/scriptEvents";
  import ClaudeTerminalPane from "./lib/components/ClaudeTerminalPane.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import EmptyState from "./lib/components/EmptyState.svelte";
  import Header from "./lib/components/Header.svelte";
  import HeaderIconButton from "./lib/components/HeaderIconButton.svelte";
  import ViewToggle from "./lib/components/ViewToggle.svelte";
  import RunScripts from "./lib/components/RunScripts.svelte";
  import RunOutput from "./lib/components/RunOutput.svelte";
  import Worktrees from "./lib/components/Worktrees.svelte";
  import Chat from "./lib/components/Chat.svelte";
  import ThreadPanel from "./lib/components/ThreadPanel.svelte";
  import GitPanel from "./lib/components/GitPanel.svelte";
  import TerminalPane from "./lib/components/TerminalPane.svelte";
  import UsageIndicator from "./lib/components/UsageIndicator.svelte";
  import Settings from "./lib/components/Settings.svelte";
  import Welcome from "./lib/components/Welcome.svelte";
  import { Button } from "./lib/components/ui/button";
  import * as Tooltip from "./lib/components/ui/tooltip";
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import SettingsIcon from "@lucide/svelte/icons/settings";

  // Re-probe the login when the window regains focus, but only while the
  // sign-in notice is showing — this is the "cmd-tab to a terminal, run
  // `claude`, cmd-tab back" round trip clearing itself. Never on a normal
  // focus (the macOS check shells out to `security`).
  function onWindowFocus() {
    if (get(authState) === "missing") void refreshAuth();
    // No sidecar turn_end events under CLI-first, so usage + git-diffstat
    // freshness ride window focus (throttled internally / cheap git status).
    void refreshUsage();
    if (get(selectedWorktree)) bumpGitRefresh();
  }

  // Global shortcuts (Conductor parity): ⌘K palette, ⌘⇧N new worktree,
  // ⌘⇧D changes/diff view, ⌘⇧P the PR block (same Changes panel). Plain ⌘K
  // has no shift; all guard on meta/ctrl so typing stays unaffected.
  function onKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (!e.shiftKey && k === "k") {
      e.preventDefault();
      toggleCommandPalette();
    } else if (e.shiftKey && k === "n") {
      e.preventDefault();
      requestNewWorktree();
    } else if (e.shiftKey && (k === "d" || k === "p")) {
      e.preventDefault();
      setCenterView("chat");
      toggleMainView("changes");
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

  // Keep the selected worktree's change summary fresh so the header can show the
  // Changes tab (only when dirty) with its +/- diffstat. Re-runs on selection and
  // on gitRefreshNonce (bumped after a turn that likely touched files).
  $effect(() => {
    const wt = $selectedWorktree;
    void $gitRefreshNonce;
    if (!wt) return;
    worktreeStatus(wt)
      .then((s) =>
        setGitStat(wt, { changed: s.files.length, insertions: s.insertions, deletions: s.deletions }),
      )
      // Non-git dirs / errors → treat as no changes (Worktrees surfaces real errors).
      .catch(() => setGitStat(wt, { changed: 0, insertions: 0, deletions: 0 }));
  });

  // If the worktree on screen has no changes, don't strand the user on the (now
  // hidden) Changes tab — fall back to chat. Same for the Run tab when the
  // worktree has no script run.
  $effect(() => {
    if ($mainView === "changes" && ($activeGitStat?.changed ?? 0) === 0) setMainView("chat");
    if ($mainView === "run" && !$activeScriptRun) setMainView("chat");
    if ($mainView === "term" && !$selectedWorktree) setMainView("chat");
  });

  // Don't strand a worktree in CLI chat mode when its provider has no CLI
  // (provider switched / stale persistence) — same fallback family as the
  // stranded-tab guards above.
  $effect(() => {
    const wt = $selectedWorktree;
    if (wt && $activeChatMode === "cli" && !providerDisplay($activeProvider).cliChat) {
      setChatMode(wt, "gui");
    }
  });

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    // Populate the subscription-usage chip on launch (throttled thereafter).
    refreshUsage();
    // Probe the provider login for the sign-in notice (local read, silent).
    void refreshAuth();

    // CLI-first freshness cadence: with no turn_end events, poll the selected
    // worktree's git diffstat (cheap status subprocess) so the Changes tab
    // notices CLI-made edits, and keep the usage chip current (refreshUsage
    // self-throttles to 90s). Window focus also triggers both (onWindowFocus).
    const freshness = setInterval(() => {
      if (get(selectedWorktree)) bumpGitRefresh();
      void refreshUsage();
    }, 30_000);

    // The dispatch logic lives in lib/agentEvents.ts (plain, testable TS); App
    // just wires the stream to it. Under CLI-first no sidecar ever runs, so
    // this stream is silent — skip the wiring entirely (the router is part of
    // the deprecated GUI surface; see CHAT_SURFACE).
    if (CHAT_SURFACE !== "cli") {
      onAgentEvent(handleAgentEvent, handleSessionStatus)
        .then((u) => {
          if (cancelled) u();
          else unlisten = u;
        })
        .catch(() => {});
    }

    // Same wiring for the script-output stream (lib/scriptEvents.ts).
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
      for (const repo of get(repos)) {
        try {
          const wts = await listWorktrees(repo.path);
          setWorktrees(repo.path, wts);
        } catch {
          // repo moved/deleted — leave it empty in the sidebar
        }
      }
      const sel = get(selectedWorktree);
      if (sel) {
        const exists = Object.values(get(worktreesByRepo)).some((list) =>
          list.some((w) => w.path === sel),
        );
        if (!exists) {
          selectWorktree(null);
        } else if (CHAT_SURFACE === "cli" || (get(chatModeByWorktree)[sel] ?? "gui") === "cli") {
          // The CLI — not a sidecar — owns this session (CLI-first surface, or
          // the legacy persisted toggle state); ClaudeTerminalPane's mount
          // reopens the PTY (resuming the newest session id). Starting a
          // sidecar here would double-own the session.
        } else {
          // Resume the persisted selection's session on launch (idempotent) so
          // the chat — and its model switcher — are usable without re-selecting.
          // ensureSession passes the persisted session id so the agent's context
          // resumes too. Status shows the boot gap as `starting`; the sidecar's
          // `ready`/`models` events flip it to ready + fill the catalog.
          try {
            setStatus(sel, "starting");
            await ensureSession(sel);
          } catch {
            // a real spawn failure surfaces via the agent-event error path
            setStatus(sel, "stopped");
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(freshness);
      unlisten?.();
      unlistenScripts?.();
      unlistenTerm?.();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} onfocus={onWindowFocus} />

<Tooltip.Provider delayDuration={100}>
<CommandPalette />
<div class="layout" class:resizing style="--sidebar-width: {$sidebarWidth}px">
  <!-- Sidebar toggle floats over the top-left (just past the traffic lights) so
       it stays put when the sidebar slides away and can always reopen it. -->
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <HeaderIconButton {...props} onclick={toggleSidebar} aria-label="Toggle sidebar">
          <PanelLeft />
        </HeaderIconButton>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>{$sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}</Tooltip.Content>
  </Tooltip.Root>

  <aside class="sidebar" class:collapsed={!$sidebarOpen}>
    <!-- empty strip aligning the worktree list's top with the content's top bar
         and clearing the traffic lights + floating toggle; the sidebar's right
         border runs full-height as the only column divider. -->
    <div class="sidebar-head" data-tauri-drag-region></div>
    <div class="sidebar-list"><Worktrees /></div>
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
        <div class="workspace-label">
          {#if $centerView === "settings"}
            <span class="path">Settings</span>
          {:else if $selectedWorktree}
            <span class="path">{$selectedWorktree}</span>
          {:else if $repos.length === 0}
            <span class="dim">add a repository to get started</span>
          {:else}
            <span class="dim">select or create a worktree on the left</span>
          {/if}
        </div>
      {/snippet}
      {#snippet actions()}
        <!-- Hidden on Settings and on the zero-repo welcome — the toggles have
             nothing to act on there. (ChatModeToggle is unwired under the
             CLI-first CHAT_SURFACE — the terminal IS the chat; the component
             is preserved for the legacy GUI surface.) -->
        {#if $centerView !== "settings" && $repos.length > 0}
          <!-- Usage chip lives in the header under CLI-first (its old home,
               the Composer footer, is part of the deprecated GUI chat). -->
          <UsageIndicator />
          <RunScripts />
          <ViewToggle />
        {/if}
      {/snippet}
    </Header>
    <div class="content">
      {#if $centerView === "settings"}
        <Settings />
      {:else if $repos.length === 0}
        <!-- First-run (or removed-last-repo) welcome: replaces the whole center
             pane, composer included. Gated on repo count — state, not a flag —
             so it reappears exactly when it's true again. -->
        <Welcome />
      {:else if $mainView === "changes"}
        <GitPanel />
      {:else if $mainView === "run"}
        <RunOutput />
      {:else if $mainView === "term"}
        <TerminalPane />
      {:else if $selectedWorktree && (CHAT_SURFACE === "cli" || $activeChatMode === "cli")}
        <!-- The chat: the REAL agent CLI TUI (CLI-first — see CHAT_SURFACE in
             stores.ts; also the legacy per-worktree toggle state). -->
        <ClaudeTerminalPane />
      {:else if CHAT_SURFACE === "cli"}
        <!-- No worktree selected. A dedicated empty state (NOT the deprecated
             Chat's empty shell) so the GUI-chat subtree stays fully out of the
             live tree under CLI-first. -->
        <EmptyState />
      {:else}
        <!-- DEPRECATED GUI chat surface — reachable only with CHAT_SURFACE
             flipped back to "gui" (see CLAUDE.md › Deprecated GUI surface). -->
        <Chat />
      {/if}
    </div>
    <!-- Thread overlay: a right-side Sheet that floats over the content (driven by
         $activeCommentId). Portals out, so it never reflows the layout above. -->
    <ThreadPanel />
  </main>
</div>
</Tooltip.Provider>
