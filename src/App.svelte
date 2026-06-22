<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { onAgentEvent, listWorktrees } from "./lib/api";
  import {
    repos,
    worktreesByRepo,
    selectedWorktree,
    appendMessage,
    pendingPermission,
    setStatus,
    sidebarOpen,
  } from "./lib/stores";
  import Header from "./lib/components/Header.svelte";
  import Worktrees from "./lib/components/Worktrees.svelte";
  import Chat from "./lib/components/Chat.svelte";

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    onAgentEvent(
      (worktree, evt) => {
        if (evt.kind === "message") {
          appendMessage(worktree, evt.message);
          // A `result` message ends the turn — the agent is idle again.
          if (evt.message.type === "result") setStatus(worktree, "running");
        } else if (evt.kind === "permission_request") {
          pendingPermission.update((p) => ({
            ...p,
            [worktree]: { id: evt.id, tool: evt.tool, input: evt.input },
          }));
        } else if (evt.kind === "error") {
          appendMessage(worktree, { type: "error", error: evt.error });
        } else if (evt.kind === "ready") {
          setStatus(worktree, "running");
        }
      },
      (worktree, kind, data) => {
        // OS-level session lifecycle: a terminate OR a spawn/IO error stops it.
        setStatus(worktree, "stopped");
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
        if (!exists) selectedWorktree.set(null);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  });
</script>

<div class="layout">
  <Header title="trickshot" />
  <div class="app-body">
    {#if $sidebarOpen}
      <aside class="sidebar"><Worktrees /></aside>
    {/if}
    <main class="content"><Chat /></main>
  </div>
</div>
