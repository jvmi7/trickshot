<script lang="ts">
  // ⌘K command palette: fuzzy-jump to any workspace + the core actions (new
  // worktree, views, run scripts, settings). Feature component — App owns the
  // shortcut; this renders the shadcn Command dialog over the stores.
  import {
    activateWorktree,
    activeRepo,
    activeScriptRun,
    activeScripts,
    addChat,
    archivedWorkspaces,
    chatLayout,
    chatSessionsByWorktree,
    closeCommandPalette,
    commandPaletteOpen,
    restoreWorkspace,
    setChatLayout,
    setChangesOpen,
    setMainView,
    toggleShell,
    setTheme,
    repos,
    requestNewWorktree,
    selectedWorktree,
    selectWorktree,
    setCenterView,
    toggleCompose,
    toggleSidebar,
    toggleShortcutsHelp,
    themeOptions,
    worktreesByRepo,
  } from "../stores";
  import * as api from "../api";
  import * as Command from "$lib/components/ui/command";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Plus from "@lucide/svelte/icons/plus";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import GitPullRequest from "@lucide/svelte/icons/git-pull-request";
  import Play from "@lucide/svelte/icons/play";
  import Square from "@lucide/svelte/icons/square";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import Palette from "@lucide/svelte/icons/palette";
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import Keyboard from "@lucide/svelte/icons/keyboard";
  import PenLine from "@lucide/svelte/icons/pen-line";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";

  // Grid⇄tabs only makes sense with >1 chat (the strip's own guard).
  const multiChat = $derived(
    !!$selectedWorktree && ($chatSessionsByWorktree[$selectedWorktree] ?? []).length > 1,
  );

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
    closeCommandPalette();
    action();
  }

  function startRun(name: string) {
    const repo = $activeRepo;
    const w = $selectedWorktree;
    if (!repo || !w) return;
    // Errors surface in the Run tab's header control; the palette is fire-and-forget.
    api.runScript(repo.path, w, name).then(() => setMainView("run"), () => {});
  }
</script>

<!-- Spotlight-shaped: wide horizontal bar (over the dialog's sm:max-w-sm
     default) with a fainter outline ring. -->
<Command.Dialog
  bind:open={$commandPaletteOpen}
  title="Command palette"
  description="Jump to a workspace or run an action"
  class="sm:max-w-xl! ring-foreground/5!"
>
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
            <GitBranch class="size-3.5" />
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
      {#if allWorktrees.length > 0}
        <Command.Item
          value="home fleet overview all workspaces dashboard"
          onSelect={() => pick(() => { setCenterView("chat"); selectWorktree(null); })}
        >
          <LayoutGrid class="size-3.5" />
          Home
        </Command.Item>
      {/if}
      {#if $selectedWorktree}
        <Command.Item value="chat view" onSelect={() => pick(() => { setCenterView("chat"); setMainView("chat"); })}>
          <MessageSquare class="size-3.5" />
          Go to chat
        </Command.Item>
        <Command.Item
          value="new chat session"
          onSelect={() => pick(() => { setCenterView("chat"); setMainView("chat"); addChat($selectedWorktree ?? ""); })}
        >
          <Plus class="size-3.5" />
          New chat
        </Command.Item>
        {#if multiChat}
          <Command.Item
            value="chat layout grid tabs toggle"
            onSelect={() => pick(() => { setCenterView("chat"); setMainView("chat"); setChatLayout($chatLayout === "grid" ? "tabs" : "grid"); })}
          >
            <LayoutGrid class="size-3.5" />
            {$chatLayout === "grid" ? "Chat tabs layout" : "Chat grid layout"}
          </Command.Item>
        {/if}
        <Command.Item value="shell terminal zsh" onSelect={() => pick(toggleShell)}>
          <SquareTerminal class="size-3.5" />
          Shell terminal
        </Command.Item>
        <Command.Item
          value="compose long prompt editor write"
          onSelect={() => pick(() => { setCenterView("chat"); toggleCompose(); })}
        >
          <PenLine class="size-3.5" />
          Compose long prompt
          <Command.Shortcut>⌘E</Command.Shortcut>
        </Command.Item>
        <Command.Item
          value="changes diff pull request pr view"
          onSelect={() => pick(() => { setCenterView("chat"); setChangesOpen(true); })}
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
        <Command.Shortcut>⌘,</Command.Shortcut>
      </Command.Item>
      <Command.Item value="toggle sidebar" onSelect={() => pick(toggleSidebar)}>
        <PanelLeft class="size-3.5" />
        Toggle sidebar
      </Command.Item>
      <Command.Item value="keyboard shortcuts help keys" onSelect={() => pick(toggleShortcutsHelp)}>
        <Keyboard class="size-3.5" />
        Keyboard shortcuts
        <Command.Shortcut>⌘/</Command.Shortcut>
      </Command.Item>
      {#each $themeOptions as t (t.id)}
        <Command.Item value="theme {t.label}" onSelect={() => pick(() => setTheme(t.id))}>
          <Palette class="size-3.5" />
          Theme: {t.label}
        </Command.Item>
      {/each}
    </Command.Group>

    {#if $archivedWorkspaces.length > 0}
      <Command.Group heading="Archived">
        {#each $archivedWorkspaces as a (a.repoPath + a.branch)}
          <Command.Item
            value="restore archived {a.repoName} {a.branch}"
            onSelect={() => pick(() => void restoreWorkspace(a).catch(() => {}))}
          >
            <ArchiveRestore class="size-3.5" />
            Restore {a.repoName} / {a.branch}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
  </Command.List>
</Command.Dialog>
