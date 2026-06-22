<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { onAgentEvent, listWorktrees, setModel, startSession } from "./lib/api";
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
  } from "./lib/stores";

  import { contentBlocks, toolLabel, toolDetail } from "./lib/sdkMessage";
  import type { SDKMessageLike } from "./lib/types";

  // ---- Verbose loading state: turn each streamed message into a human-readable
  // "what's happening now" for the chat's loading footer. ----
  function updateActivity(worktree: string, m: SDKMessageLike) {
    if (m.type === "assistant") {
      const blocks = contentBlocks(m);
      const tool = blocks.find((b) => b && b.type === "tool_use");
      if (tool) {
        setActivity(worktree, toolLabel(String(tool.name)), toolDetail(String(tool.name), tool.input as Record<string, unknown>), true);
      } else if (blocks.some((b) => b && b.type === "text" && String(b.text ?? "").trim())) {
        setActivity(worktree, "Writing response", "");
      }
    } else if (m.type === "user") {
      // a tool result came back — the agent is reasoning again
      setActivity(worktree, "Thinking", "");
    } else if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
      setActivity(worktree, "Connecting", "");
    }
  }
  import Header from "./lib/components/Header.svelte";
  import HeaderIconButton from "./lib/components/HeaderIconButton.svelte";
  import Worktrees from "./lib/components/Worktrees.svelte";
  import Chat from "./lib/components/Chat.svelte";
  import Settings from "./lib/components/Settings.svelte";
  import * as Tooltip from "./lib/components/ui/tooltip";
  import PanelLeft from "@lucide/svelte/icons/panel-left";

  const toggleSidebar = () => sidebarOpen.update((v) => !v);

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    onAgentEvent(
      (worktree, evt) => {
        if (evt.kind === "message") {
          const m = evt.message;
          // Persist the latest session id so we can resume this worktree's
          // context after a restart (the id rides on every SDK message).
          const sid = (m as { session_id?: unknown }).session_id;
          if (typeof sid === "string" && sid) setWorktreeSession(worktree, sid);
          // `system` (init) messages are session-lifecycle noise that would
          // pile up in the persisted transcript on every resume — capture their
          // id above, but don't render them.
          updateActivity(worktree, m);
          // Skip lifecycle messages: `system` (init/hooks) and `result` (a turn-end
          // marker whose text just duplicates the final assistant message).
          if (m.type !== "system" && m.type !== "result") appendMessage(worktree, m);
          // A `result` message ends the turn — the agent is idle again.
          if (m.type === "result") {
            setStatus(worktree, "ready");
            clearActivity(worktree);
          }
        } else if (evt.kind === "permission_request") {
          pendingPermission.update((p) => ({
            ...p,
            [worktree]: { id: evt.id, tool: evt.tool, input: evt.input },
          }));
        } else if (evt.kind === "error") {
          appendMessage(worktree, { type: "error", error: evt.error });
        } else if (evt.kind === "ready") {
          setStatus(worktree, "ready");
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
        }
      },
      (worktree, kind, data) => {
        // OS-level session lifecycle: a terminate OR a spawn/IO error stops it.
        setStatus(worktree, "stopped");
        clearActivity(worktree);
        if (kind === "error") {
          appendMessage(worktree, {
            type: "error",
            error: data ? `session error: ${data}` : "session error",
          });
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
            await startSession(sel, get(sessionByWorktree)[sel]);
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
<div class="layout">
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

  <!-- Settings (gear) floats top-right, in line with the sidebar toggle. -->
  <Settings />

  <aside class="sidebar" class:collapsed={!$sidebarOpen}>
    <!-- empty strip aligning the worktree list's top with the content's top bar
         and clearing the traffic lights + floating toggle; the sidebar's right
         border runs full-height as the only column divider. -->
    <div class="sidebar-head" data-tauri-drag-region></div>
    <div class="sidebar-list"><Worktrees /></div>
  </aside>

  <main class="main">
    <!-- top bar: the workspace path sits inline in the header band. -->
    <Header>
      <div slot="left" class="workspace-label">
        {#if $selectedWorktree}
          <span class="path">{$selectedWorktree}</span>
        {:else}
          <span class="dim">select or create a worktree on the left</span>
        {/if}
      </div>
    </Header>
    <div class="content"><Chat /></div>
  </main>
</div>
</Tooltip.Provider>
