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

  // ---- Verbose loading state: turn each streamed message into a human-readable
  // "what's happening now" for the chat's loading footer. ----
  const basename = (p: unknown) => String(p ?? "").split("/").pop() || String(p ?? "");
  const trunc = (s: unknown, n = 64) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  function toolLabel(name: string): string {
    switch (name) {
      case "Bash": return "Running command";
      case "Read": return "Reading";
      case "Write": return "Writing file";
      case "Edit":
      case "MultiEdit": return "Editing";
      case "NotebookEdit": return "Editing notebook";
      case "Glob": return "Finding files";
      case "Grep": return "Searching";
      case "Task": return "Delegating";
      case "WebFetch": return "Fetching";
      case "WebSearch": return "Searching the web";
      case "TodoWrite": return "Updating plan";
      default: return "Running " + name.replace(/^mcp__/, "").replace(/_/g, " ");
    }
  }
  function toolDetail(name: string, input: Record<string, unknown> = {}): string {
    switch (name) {
      case "Bash": return trunc(input.command);
      case "Read":
      case "Write":
      case "Edit":
      case "MultiEdit": return basename(input.file_path);
      case "NotebookEdit": return basename(input.notebook_path);
      case "Glob":
      case "Grep": return trunc(input.pattern);
      case "Task": return trunc(input.description);
      case "WebFetch": return trunc(input.url);
      case "WebSearch": return trunc(input.query);
      default: return "";
    }
  }
  function updateActivity(worktree: string, m: { type: string; [k: string]: unknown }) {
    if (m.type === "assistant") {
      const content = (m as { message?: { content?: unknown } }).message?.content;
      const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
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
  import Worktrees from "./lib/components/Worktrees.svelte";
  import Chat from "./lib/components/Chat.svelte";
  import ThemeSelector from "./lib/components/ThemeSelector.svelte";
  import FontSelector from "./lib/components/FontSelector.svelte";

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
            setStatus(worktree, "running");
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
          setStatus(worktree, "running");
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
          // The `ready`/`models` events flip status to running and fill the catalog.
          try {
            await startSession(sel, get(sessionByWorktree)[sel]);
            setStatus(sel, "running");
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

<div class="layout">
  <Header>
    <button
      slot="left"
      class="menu-btn"
      onclick={toggleSidebar}
      title={$sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      aria-label="Toggle sidebar"
    >
      <svg
        viewBox="0 0 24 24"
        width="17"
        height="17"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="9" y1="4" x2="9" y2="20" />
      </svg>
    </button>
    <div slot="actions" class="flex items-center gap-1 self-start mt-1">
      <FontSelector />
      <ThemeSelector />
    </div>
  </Header>
  <div class="app-body">
    <aside class="sidebar" class:collapsed={!$sidebarOpen}><Worktrees /></aside>
    <main class="content"><Chat /></main>
  </div>
</div>
