<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { onAgentEvent, listWorktrees, worktreeStatus } from "./lib/api";
  import {
    repos,
    worktreesByRepo,
    setWorktrees,
    selectedWorktree,
    selectWorktree,
    setStatus,
    sidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    centerView,
    setCenterView,
    refreshUsage,
    ensureSession,
    mainView,
    gitRefreshNonce,
    setGitStat,
    activeGitStat,
  } from "./lib/stores";
  import { handleAgentEvent, handleSessionStatus } from "./lib/agentEvents";
  import Header from "./lib/components/Header.svelte";
  import HeaderIconButton from "./lib/components/HeaderIconButton.svelte";
  import ViewToggle from "./lib/components/ViewToggle.svelte";
  import Worktrees from "./lib/components/Worktrees.svelte";
  import Chat from "./lib/components/Chat.svelte";
  import GitPanel from "./lib/components/GitPanel.svelte";
  import Settings from "./lib/components/Settings.svelte";
  import { Button } from "./lib/components/ui/button";
  import * as Tooltip from "./lib/components/ui/tooltip";
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import SettingsIcon from "@lucide/svelte/icons/settings";

  const toggleSidebar = () => sidebarOpen.update((v) => !v);

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
  // hidden) Changes tab — fall back to chat.
  $effect(() => {
    if ($mainView === "changes" && ($activeGitStat?.changed ?? 0) === 0) mainView.set("chat");
  });

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    // Populate the subscription-usage chip on launch (throttled thereafter).
    refreshUsage();

    // The dispatch logic lives in lib/agentEvents.ts (plain, testable TS); App
    // just wires the stream to it.
    onAgentEvent(handleAgentEvent, handleSessionStatus)
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
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
        } else {
          // Resume the persisted selection's session on launch (idempotent) so
          // the chat — and its model switcher — are usable without re-selecting.
          // ensureSession passes the persisted session id so the agent's context
          // resumes too. The `ready`/`models` events flip status + fill the catalog.
          try {
            await ensureSession(sel);
            setStatus(sel, "ready");
          } catch {
            // a real spawn failure surfaces via the agent-event error path
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  });
</script>

<Tooltip.Provider delayDuration={100}>
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
          {:else}
            <span class="dim">select or create a worktree on the left</span>
          {/if}
        </div>
      {/snippet}
      {#snippet actions()}
        {#if $centerView !== "settings"}
          <ViewToggle />
        {/if}
      {/snippet}
    </Header>
    <div class="content">
      {#if $centerView === "settings"}
        <Settings />
      {:else if $mainView === "changes"}
        <GitPanel />
      {:else}
        <Chat />
      {/if}
    </div>
  </main>
</div>
</Tooltip.Provider>
