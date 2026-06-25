<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import {
    onAgentEvent,
    listWorktrees,
    setModel,
    startSession,
    toggleConnector,
    notify,
  } from "./lib/api";
  import {
    repos,
    worktreesByRepo,
    selectedWorktree,
    appendMessage,
    pendingPermission,
    setStatus,
    sidebarOpen,
    availableModels,
    modelByWorktree,
    setWorktreeModel,
    sessionByWorktree,
    setWorktreeSession,
    setActivity,
    clearActivity,
    worktreeActivity,
    setTurnSummary,
    sidebarWidth,
    setSidebarWidth,
    setConnectors,
    globalConnectorPrefs,
    centerView,
    setCenterView,
    addTurnCost,
    permissionModeByWorktree,
    DEFAULT_PERMISSION_MODE,
    mainView,
    bumpGitRefresh,
    attachRewindId,
    availableCommands,
    systemPromptAppend,
    mcpStatus,
    getMcpServers,
    bumpUnread,
  } from "./lib/stores";

  /** Basename of a worktree path, for notification labels. */
  function shortName(path: string): string {
    return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
  }

  import { toolLabel, toolDetail } from "./lib/agentMessage";
  import type { AgentMessage } from "./lib/types";

  // ---- Verbose loading state: turn each neutral message into a human-readable
  // "what's happening now" for the chat's loading footer. ----
  function updateActivity(worktree: string, m: AgentMessage) {
    if (m.type === "tool_call") {
      setActivity(worktree, toolLabel(m.name), toolDetail(m.name, m.input), true);
    } else if (m.type === "assistant") {
      setActivity(worktree, "Writing response", "");
    } else if (m.type === "tool_result") {
      // a tool result came back — the agent is reasoning again
      setActivity(worktree, "Thinking", "");
    } else if (m.type === "system") {
      setActivity(worktree, "Connecting", "");
    }
  }
  import Header from "./lib/components/Header.svelte";
  import HeaderIconButton from "./lib/components/HeaderIconButton.svelte";
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

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    onAgentEvent(
      (worktree, evt) => {
        if (evt.kind === "message") {
          const m = evt.message;
          updateActivity(worktree, m);
          // `turn_end` ends the turn — the agent is idle again (not rendered).
          // `system` is a session notice we don't render. Everything else is a
          // transcript bubble.
          if (m.type === "turn_end") {
            setStatus(worktree, "ready");
            // Stash an end-of-turn summary (Claude-Code style) for the loading
            // footer to show while idle: how long the turn took + tool-call count.
            const act = get(worktreeActivity)[worktree];
            if (act) {
              const seconds = Math.max(0, Math.floor((Date.now() - act.startedAt) / 1000));
              setTurnSummary(worktree, { seconds, steps: act.steps });
            }
            clearActivity(worktree);
            // Fold the turn's token/cost figures into the worktree's running total.
            if (m.usage) addTurnCost(worktree, m.usage);
            // The turn likely touched files — refresh an open git panel.
            bumpGitRefresh();
            // If this worktree isn't the one on screen, flag it + notify so the
            // user notices a background agent finishing.
            if (worktree !== get(selectedWorktree)) {
              bumpUnread(worktree);
              void notify("Agent finished", shortName(worktree));
            }
          } else if (m.type !== "system") {
            appendMessage(worktree, m);
          }
        } else if (evt.kind === "session") {
          // Persist the resumable session id so this worktree's agent *context*
          // can be restored after a restart (the provider reports it once known).
          setWorktreeSession(worktree, evt.id);
        } else if (evt.kind === "permission_request") {
          pendingPermission.update((p) => ({
            ...p,
            [worktree]: { id: evt.id, tool: evt.tool, input: evt.input },
          }));
        } else if (evt.kind === "checkpoint") {
          // Tag the just-sent user turn with its rewindable checkpoint id.
          attachRewindId(worktree, evt.id);
        } else if (evt.kind === "commands") {
          availableCommands.set(evt.commands);
        } else if (evt.kind === "mcp_status") {
          mcpStatus.set(evt.servers);
        } else if (evt.kind === "notification") {
          // Agent wants attention — raise an OS notification if it's not the
          // worktree currently on screen.
          if (worktree !== get(selectedWorktree)) {
            void notify(shortName(worktree), evt.message);
          }
        } else if (evt.kind === "error") {
          // Surface only. Status is deliberately NOT reset here: this channel is
          // shared by FATAL errors (an agent-loop throw, which then exits → the
          // `terminated` event below unsticks the session) and NON-FATAL ones
          // (e.g. a setModel failure while the turn keeps streaming, which must
          // stay `busy`). Resetting here would wrongly unstick a live turn.
          appendMessage(worktree, { type: "error", error: evt.error });
        } else if (evt.kind === "ready") {
          setStatus(worktree, "ready");
        } else if (evt.kind === "connectors") {
          setConnectors(worktree, evt.servers);
          // Re-apply the GLOBAL connector preferences live (the SDK's toggle is
          // not remembered across sessions). Toggle any connector whose live state
          // differs from the saved preference. Toggling re-publishes `connectors`;
          // the state then matches, so this converges (no toggle loop).
          const g = get(globalConnectorPrefs);
          for (const s of evt.servers) {
            const want = g[s.name];
            if (want === undefined) continue;
            const isOn = s.status !== "disabled";
            if (want !== isOn) toggleConnector(worktree, s.name, want);
          }
        } else if (evt.kind === "models") {
          availableModels.set(evt.models);
          // Each sidecar starts on the default model. If this worktree has a
          // persisted choice that differs (and is still offered), re-apply it;
          // otherwise adopt the sidecar's confirmed current as truth.
          const chosen = get(modelByWorktree)[worktree];
          const known = evt.models.some((m) => m.value === chosen);
          if (chosen && known && chosen !== evt.current) {
            setModel(worktree, chosen);
          } else {
            setWorktreeModel(worktree, evt.current);
          }
        } else {
          // Exhaustiveness: a new Outbound `kind` left unhandled here is a
          // compile error (svelte-check) — the webview half of the SYNC RULE.
          const _exhaustive: never = evt;
          void _exhaustive;
        }
      },
      (worktree, kind, data) => {
        // OS-level session lifecycle: a terminate OR a spawn/IO error stops it.
        setStatus(worktree, "stopped");
        clearActivity(worktree);
        // `data` carries diagnostics (including the buffered stderr tail) for an
        // error or an abnormal exit; it's null for a clean shutdown (stays quiet).
        if (kind === "error") {
          appendMessage(worktree, {
            type: "error",
            error: data ? `session error: ${data}` : "session error",
          });
        } else if (data) {
          appendMessage(worktree, { type: "error", error: data });
        }
      },
    )
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
          worktreesByRepo.update((m) => ({ ...m, [repo.path]: wts }));
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
          selectedWorktree.set(null);
        } else {
          // Resume the persisted selection's session on launch (idempotent) so
          // the chat — and its model switcher — are usable without re-selecting.
          // Pass the persisted session id so the agent's context resumes too.
          // The `ready`/`models` events flip status to ready and fill the catalog.
          try {
            await startSession(sel, {
              resume: get(sessionByWorktree)[sel],
              permissionMode: get(permissionModeByWorktree)[sel] ?? DEFAULT_PERMISSION_MODE,
              systemPromptAppend: get(systemPromptAppend),
              mcpServers: getMcpServers(),
            });
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

<Tooltip.Provider delayDuration={300}>
<div class="layout" class:resizing style="--sidebar-width: {$sidebarWidth}px">
  <!-- Sidebar toggle floats over the top-left (just past the traffic lights) so
       it stays put when the sidebar slides away and can always reopen it. -->
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <HeaderIconButton side="left" {...props} onclick={toggleSidebar} aria-label="Toggle sidebar">
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
      <div slot="left" class="workspace-label">
        {#if $centerView === "settings"}
          <span class="path">Settings</span>
        {:else if $selectedWorktree}
          <span class="path">{$selectedWorktree}</span>
        {:else}
          <span class="dim">select or create a worktree on the left</span>
        {/if}
      </div>
      <div slot="actions" class="view-tabs">
        <Button
          size="sm"
          variant={$mainView === "chat" ? "secondary" : "ghost"}
          class="h-7 text-xs"
          onclick={() => mainView.set("chat")}>Chat</Button
        >
        <Button
          size="sm"
          variant={$mainView === "changes" ? "secondary" : "ghost"}
          class="h-7 text-xs"
          onclick={() => mainView.set("changes")}>Changes</Button
        >
      </div>
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
