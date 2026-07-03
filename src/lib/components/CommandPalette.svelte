<script lang="ts">
  // ⌘K command palette: fuzzy-jump to any workspace + the core actions (new
  // worktree, views, run scripts, settings). Feature component — App owns the
  // shortcut; this renders the shadcn Command dialog over the stores.
  import {
    activateWorktree,
    activeRepo,
    activeScriptRun,
    activeScripts,
    commandPaletteOpen,
    mainView,
    repos,
    requestNewWorktree,
    selectedWorktree,
    setCenterView,
    worktreesByRepo,
  } from "../stores";
  import * as api from "../api";
  import * as Command from "$lib/components/ui/command";
  import House from "@lucide/svelte/icons/house";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Plus from "@lucide/svelte/icons/plus";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import GitPullRequest from "@lucide/svelte/icons/git-pull-request";
  import Play from "@lucide/svelte/icons/play";
  import Square from "@lucide/svelte/icons/square";
  import SettingsIcon from "@lucide/svelte/icons/settings";

  // Flat list of every worktree across repos, labeled repo/branch for search.
  const allWorktrees = $derived(
    $repos.flatMap((repo) =>
      ($worktreesByRepo[repo.path] ?? []).map((wt) => ({
        repo,
        wt,
        label: `${repo.name} / ${wt.branch ?? "(detached)"}`,
      })),
    ),
  );

  /** Close the palette, then run the picked action. */
  function pick(action: () => void) {
    commandPaletteOpen.set(false);
    action();
  }

  function startRun(name: string) {
    const repo = $activeRepo;
    const w = $selectedWorktree;
    if (!repo || !w) return;
    // Errors surface in the Run tab's header control; the palette is fire-and-forget.
    api.runScript(repo.path, w, name).then(() => mainView.set("run"), () => {});
  }
</script>

<Command.Dialog bind:open={$commandPaletteOpen} title="Command palette" description="Jump to a workspace or run an action">
  <Command.Input placeholder="Search workspaces and actions…" />
  <Command.List>
    <Command.Empty>No results.</Command.Empty>

    {#if allWorktrees.length > 0}
      <Command.Group heading="Workspaces">
        {#each allWorktrees as { repo, wt, label } (wt.path)}
          <Command.Item
            value="workspace {label}"
            onSelect={() => pick(() => void activateWorktree(wt.path).catch(() => {}))}
          >
            {#if wt.is_main}<House class="size-3.5" />{:else}<GitBranch class="size-3.5" />{/if}
            {label}
            {#if $selectedWorktree === wt.path}
              <span class="ml-auto text-xs text-muted-foreground">current</span>
            {/if}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    <Command.Group heading="Actions">
      <Command.Item value="new worktree workspace create" onSelect={() => pick(requestNewWorktree)}>
        <Plus class="size-3.5" />
        New worktree
        <Command.Shortcut>⌘⇧N</Command.Shortcut>
      </Command.Item>
      {#if $selectedWorktree}
        <Command.Item value="chat view" onSelect={() => pick(() => { setCenterView("chat"); mainView.set("chat"); })}>
          <MessageSquare class="size-3.5" />
          Go to chat
        </Command.Item>
        <Command.Item
          value="changes diff pull request pr view"
          onSelect={() => pick(() => { setCenterView("chat"); mainView.set("changes"); })}
        >
          <GitPullRequest class="size-3.5" />
          Changes & pull request
          <Command.Shortcut>⌘⇧D</Command.Shortcut>
        </Command.Item>
        {#each $activeScripts?.run ?? [] as s (s.name)}
          <Command.Item value="run script {s.name}" onSelect={() => pick(() => startRun(s.name))}>
            <Play class="size-3.5" />
            Run: {s.name}
          </Command.Item>
        {/each}
        {#if $activeScriptRun?.status === "running"}
          <Command.Item
            value="stop script"
            onSelect={() => pick(() => void api.stopScript($selectedWorktree ?? "").catch(() => {}))}
          >
            <Square class="size-3.5" />
            Stop script ({$activeScriptRun.name})
          </Command.Item>
        {/if}
      {/if}
      <Command.Item value="settings preferences" onSelect={() => pick(() => setCenterView("settings"))}>
        <SettingsIcon class="size-3.5" />
        Settings
      </Command.Item>
    </Command.Group>
  </Command.List>
</Command.Dialog>
