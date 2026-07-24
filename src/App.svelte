<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import {
    onScriptEvent,
    onTermEvent,
    listWorktrees,
    worktreeStatus,
    homeDir,
    onWindowResized,
    windowIsFullscreen,
  } from "./lib/api";
  import { borderGlow } from "./lib/borderGlow";
  import { chatSilhouette } from "./lib/chatSilhouette";
  import { cursorTrail } from "./lib/cursorTrail";
  import { claudeTermKey, clearFocusedTerminal, handleTermEvent } from "./lib/terminal";
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
    cursorTrailEnabled,
    focusedChatByWorktree,
    DEFAULT_CHAT_ID,
  } from "./lib/stores";
  import { handleScriptEvent } from "./lib/scriptEvents";
  import { createHoverIntent } from "./lib/hoverIntent";
  import ClaudeTerminalPane from "./lib/components/ClaudeTerminalPane.svelte";
  import ChatTabs from "./lib/components/ChatTabs.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import Header from "./lib/components/Header.svelte";
  import HeaderIconButton from "./lib/components/HeaderIconButton.svelte";
  import ViewToggle from "./lib/components/ViewToggle.svelte";
  import RunScripts from "./lib/components/RunScripts.svelte";
  import SessionTicker from "./lib/components/SessionTicker.svelte";
  import RunOutput from "./lib/components/RunOutput.svelte";
  import Worktrees from "./lib/components/Worktrees.svelte";
  import ArchivedSection from "./lib/components/ArchivedSection.svelte";
  import Home from "./lib/components/Home.svelte";
  import Settings from "./lib/components/Settings.svelte";
  import ComposeDialog from "./lib/components/ComposeDialog.svelte";
  import ShortcutsHelp from "./lib/components/ShortcutsHelp.svelte";
  import Footer from "./lib/components/Footer.svelte";
  import { Button } from "./lib/components/ui/button";
  import { Toaster } from "./lib/components/ui/sonner";
  import * as Tooltip from "./lib/components/ui/tooltip";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import PanelLeft from "@lucide/svelte/icons/panel-left";

  // Re-probe the login when the window regains focus, but only while the
  // sign-in notice is showing — this is the "cmd-tab to a terminal, run
  // `claude`, cmd-tab back" round trip clearing itself. Never on a normal
  // focus (the macOS check shells out to `security`).
  function onWindowFocus() {
    if (get(authState) === "missing") void refreshAuth();
  }

  // Global shortcuts (Conductor parity): ⌘P palette, ⌘K clear the focused
  // terminal, ⌘⇧N new worktree, ⌘⇧D changes/diff view, ⌘⇧P the PR block (same
  // Changes panel), ⌘, settings, ⌘1–9 jump to the Nth worktree (sidebar
  // order). Esc leaves Settings. All ⌘-chords guard on meta/ctrl so typing
  // stays unaffected (macOS ⌘-chords never reach the PTY through xterm, so
  // nothing is stolen from the TUI).
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
    } else if (!e.shiftKey && k === "p") {
      e.preventDefault();
      toggleCommandPalette();
    } else if (!e.shiftKey && k === "k") {
      // Terminal muscle memory: clear whichever terminal owns the keyboard —
      // or, since the composer usually does, the SELECTED worktree's focused
      // chat terminal (the one on screen).
      const wt = get(selectedWorktree);
      const chat = wt ? (get(focusedChatByWorktree)[wt] ?? DEFAULT_CHAT_ID) : undefined;
      if (clearFocusedTerminal(wt ? claudeTermKey(wt, chat) : undefined)) e.preventDefault();
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
  // Hover-peek: the floating sidebar overlay while collapsed (left-edge graze).
  // Once the slide-in STARTS it always completes: close requests during the
  // flight are queued and applied only after the open settles (and only if
  // the pointer isn't resting on the panel by then).
  let sidebarPeek = $state(false);
  let peekEl = $state<HTMLElement | null>(null);
  let peekSettled = false;
  let peekCloseQueued = false;
  let peekHover = false;
  // Settle on a TIMER (slide duration + slack), not transitionend — a missed
  // end event would leave a queued close stranded and the panel stuck open.
  const PEEK_SETTLE_MS = 340;
  function openPeek() {
    peekCloseQueued = false;
    if (sidebarPeek) return;
    sidebarPeek = true;
    peekSettled = false;
    setTimeout(() => {
      peekSettled = true;
      if (peekCloseQueued && !peekHover) sidebarPeek = false;
      peekCloseQueued = false;
    }, PEEK_SETTLE_MS);
  }
  function requestClosePeek() {
    if (!sidebarPeek) return;
    if (!peekSettled) {
      peekCloseQueued = true;
      return;
    }
    sidebarPeek = false;
  }
  // Hover intent in front of the settle choreography: a pointer merely
  // GRAZING the edge zone (common in fullscreen, where the zone hugs the
  // screen edge) must not flash the panel in and straight back out — the
  // open waits for a dwell, and a brief exit is forgiven by the close grace.
  // The settle queue above still guarantees a started slide-in completes.
  const peekIntent = createHoverIntent({
    setOpen: (v) => (v ? openPeek() : requestClosePeek()),
  });
  $effect(() => () => peekIntent.cancel());
  // 50px past the width clamp (stores.ts › SIDEBAR_MIN = 200) reads as intent
  // to close, not to resize.
  const SIDEBAR_CLOSE_AT = 150;
  function startResize(e: PointerEvent) {
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startW = get(sidebarWidth);
    const up = () => {
      resizing = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    const move = (ev: PointerEvent) => {
      const raw = startW + (ev.clientX - startX);
      // Dragging well past the minimum width CLOSES the sidebar (there is no
      // collapse button) — the floating PanelLeft button reopens it.
      if (raw < SIDEBAR_CLOSE_AT) {
        up();
        if (get(sidebarOpen)) toggleSidebar();
        return;
      }
      setSidebarWidth(raw);
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

    // Track macOS fullscreen (the traffic lights hide there — the floating
    // expand-sidebar button re-anchors via html[data-fullscreen]).
    const syncFullscreen = () =>
      void windowIsFullscreen()
        .then((fs) => {
          if (fs) document.documentElement.dataset.fullscreen = "";
          else delete document.documentElement.dataset.fullscreen;
        })
        .catch(() => {});
    syncFullscreen();
    let unlistenResize: (() => void) | undefined;
    onWindowResized(syncFullscreen)
      .then((u) => (unlistenResize = u))
      .catch(() => {});

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
      unlistenResize?.();
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
  {#if !$sidebarOpen}
    <!-- Collapsed: the one way back — a floating titlebar button just past
         the traffic lights. -->
    <HeaderIconButton aria-label="Expand sidebar" title="Expand sidebar" onclick={toggleSidebar}>
      <PanelLeft />
    </HeaderIconButton>
  {/if}
  {#snippet sidebarContent()}
    <div class="sidebar-list"><Worktrees /></div>
    <!-- Archived workspaces: pinned BELOW the scrolling list (its own footer
         band) so a long repo list can't push it off screen. -->
    <ArchivedSection />
    <!-- Opens the full Settings page in the center pane, in place of the
         chat. -->
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
  {/snippet}

  <aside class="sidebar" class:collapsed={!$sidebarOpen}>
    <!-- empty strip aligning the worktree list's top with the content's top bar
         and clearing the traffic lights + floating toggle; the sidebar's right
         border runs full-height as the only column divider. -->
    <div class="sidebar-head" data-tauri-drag-region></div>
    {@render sidebarContent()}
  </aside>

  {#if !$sidebarOpen}
    <!-- PEEK: with the sidebar closed, grazing the window's left edge slides
         a floating copy of it in (the Linear pattern) — same content via the
         snippet above, gone when the pointer leaves it. -->
    <!-- Scrim behind the peek: fades with it; pointer-events none — purely
         visual, the hover choreography stays on the zone/panel. -->
    <div class="sidebar-peek-scrim" class:open={sidebarPeek}></div>
    <div
      class="sidebar-peek-zone"
      role="presentation"
      onpointerenter={() => peekIntent.enter()}
      onpointerleave={(e: PointerEvent) => {
        if (!(e.relatedTarget instanceof Node) || !peekEl?.contains(e.relatedTarget))
          peekIntent.leave();
        else peekIntent.cancelClose();
      }}
    ></div>
    <div
      bind:this={peekEl}
      class="sidebar-peek"
      class:open={sidebarPeek}
      role="presentation"
      onpointerenter={() => {
        peekHover = true;
        peekCloseQueued = false;
        peekIntent.cancelClose();
      }}
      onpointerleave={() => {
        peekHover = false;
        peekIntent.leave();
      }}
    >
      {@render sidebarContent()}
    </div>
  {/if}

  <main class="main">
    <!-- top bar: the workspace path sits inline in the header band. -->
    <Header>
      {#snippet actions()}
        <!-- Hidden on Settings and on the zero-repo welcome — the toggles have
             nothing to act on there. -->
        {#if $centerView !== "settings" && $repos.length > 0}
          <SessionTicker />
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
      {#if $sidebarOpen}
        <!-- Sidebar drag handle, anchored to the CARD: its line overlaps the
             terminal's left border and spans only the straight edge between
             the corner curves (top/bottom inset by the pane radius). -->
        <div
          class="sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onpointerdown={startResize}
        ></div>
      {/if}
      {#if $cursorTrailEnabled && $centerView !== "settings" && $repos.length > 0 && $mainView !== "run" && $selectedWorktree}
        <!-- ONE shared background for the whole chat surface: a single trail
             canvas clipped to the card∪tab silhouette (chatSilhouette). The
             tab and the terminal panes above are transparent — the chrome is
             a mask over this surface, so the pixel wake is seamless. -->
        <div class="chat-trail" aria-hidden="true" use:cursorTrail use:chatSilhouette></div>
      {/if}
      <div class="content-clip">
      {#if $centerView === "settings"}
        <Settings />
      {:else if $repos.length === 0}
        <!-- First-run (or removed-last-repo): the homepage in its onboarding
             state replaces the whole center pane, composer included. Gated on
             repo count — state, not a flag — so it reappears exactly when
             it's true again. -->
        <Home />
      {:else if $mainView === "run"}
        <RunOutput />
      {:else if !$selectedWorktree}
        <!-- No selection + repos exist: the homepage with the fleet grid
             (mission control), not a dead-end hint. The palette's "Home"
             deselects to land here. -->
        <Home />
      {:else}
        <!-- The chat: the REAL Claude Code TUI on the worktree's claude PTY. -->
        <ClaudeTerminalPane />
      {/if}
      </div>
    </div>
    <!-- Status footer: usage + ambient items live UNDER the work, not in the
         header. -->
    <Footer />
  </main>
</div>
</Tooltip.Provider>
