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
    activeRepo,
    activateWorktree,
    toggleCommandPalette,
    requestNewWorktree,
  } from "./lib/stores";
  import { handleAgentEvent, handleSessionStatus } from "./lib/agentEvents";
  import { handleScriptEvent } from "./lib/scriptEvents";
  import ClaudeTerminalPane from "./lib/components/ClaudeTerminalPane.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import Header from "./lib/components/Header.svelte";
  import HeaderIconButton from "./lib/components/HeaderIconButton.svelte";
  import ViewToggle from "./lib/components/ViewToggle.svelte";
  import RunScripts from "./lib/components/RunScripts.svelte";
  import RunOutput from "./lib/components/RunOutput.svelte";
  import Worktrees from "./lib/components/Worktrees.svelte";
  import Fleet from "./lib/components/Fleet.svelte";
  import Chat from "./lib/components/Chat.svelte";
  import ThreadPanel from "./lib/components/ThreadPanel.svelte";
  import GitPanel from "./lib/components/GitPanel.svelte";
  import TerminalPane from "./lib/components/TerminalPane.svelte";
  import Settings from "./lib/components/Settings.svelte";
  import Welcome from "./lib/components/Welcome.svelte";
  import UsageIndicator from "./lib/components/UsageIndicator.svelte";
  import { Button } from "./lib/components/ui/button";
  import { Toaster } from "./lib/components/ui/sonner";
  import * as Tooltip from "./lib/components/ui/tooltip";
  import { basename } from "./lib/utils";
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import SettingsIcon from "@lucide/svelte/icons/settings";

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
    if (!e.shiftKey && k === ",") {
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
      toggleMainView("changes");
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
    if ($mainView === "changes" && (gs?.changed ?? 0) === 0 && (gs?.aheadOfDefault ?? 0) === 0)
      setMainView("chat");
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

    // The dispatch logic lives in lib/agentEvents.ts (plain, testable TS); App
    // just wires the stream to it.
    onAgentEvent(handleAgentEvent, handleSessionStatus)
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});

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
      unlisten?.();
      unlistenScripts?.();
      unlistenTerm?.();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} onfocus={onWindowFocus} />

<Tooltip.Provider delayDuration={100}>
<Toaster position="bottom-right" />
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
            <span class="path" title={$selectedWorktree}>
              {$activeRepo ? basename($activeRepo.path) : basename($selectedWorktree)}{#if activeBranch}<span
                  class="dim"
                >
                  / {activeBranch}</span
                >{/if}
            </span>
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
             is preserved for the legacy GUI surface.) UsageIndicator lives here
             (not the deprecated Composer) so budget stays visible under
             CLI-first chat. -->
        {#if $centerView !== "settings" && $repos.length > 0}
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
      {:else if !$selectedWorktree}
        <!-- No selection + repos exist: the fleet overview (mission control),
             not a dead-end hint. The palette's "Fleet overview" deselects to
             land here. -->
        <Fleet />
      {:else if $selectedWorktree && (CHAT_SURFACE === "cli" || $activeChatMode === "cli")}
        <!-- The chat: the REAL Claude Code TUI (CLI-first — see CHAT_SURFACE in
             stores.ts; also the legacy per-worktree toggle state). The GUI Chat
             below is deprecated-but-preserved, reachable only with no worktree
             selected (its empty state) or by flipping CHAT_SURFACE back. -->
        <ClaudeTerminalPane />
      {:else}
        <Chat />
      {/if}
    </div>
    <!-- Thread overlay: a right-side Sheet that floats over the content (driven by
         $activeCommentId). Portals out, so it never reflows the layout above. -->
    <ThreadPanel />
  </main>
</div>
</Tooltip.Provider>
