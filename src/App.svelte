<script lang="ts">
  import { onMount } from "svelte";
  import { onAgentEvent } from "./lib/api";
  import { messages, pendingPermission } from "./lib/stores";
  import Worktrees from "./lib/components/Worktrees.svelte";
  import Chat from "./lib/components/Chat.svelte";

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    onAgentEvent((e) => {
      if (e.kind === "message") {
        messages.update((m) => [...m, e.message]);
      } else if (e.kind === "permission_request") {
        pendingPermission.set({ id: e.id, tool: e.tool, input: e.input });
      } else if (e.kind === "error") {
        messages.update((m) => [...m, { type: "error", error: e.error }]);
      }
      // "ready" is ignored for now.
    }).then((u) => {
      // If the component unmounted before registration resolved, tear down now.
      if (cancelled) u();
      else unlisten = u;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  });
</script>

<main class="layout">
  <aside class="sidebar">
    <Worktrees />
  </aside>
  <section class="content">
    <Chat />
  </section>
</main>
