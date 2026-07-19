<script lang="ts">
  // Header Run control for the repo's `.trickshot/settings.json` run scripts:
  // one script → a plain Run/Stop button; several → Run opens a menu. While a
  // script runs the button turns into Stop and the Run tab (ViewToggle) shows
  // its live output. Feature component (couples to stores/api by design).
  import {
    activeRepo,
    activeScriptRun,
    activeScripts,
    setMainView,
    refreshScripts,
    selectedWorktree,
  } from "../stores";
  import * as api from "../api";
  import { toastError } from "../toast";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import Play from "@lucide/svelte/icons/play";
  import Square from "@lucide/svelte/icons/square";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  let error = $state("");

  const wt = $derived($selectedWorktree);
  const running = $derived($activeScriptRun?.status === "running");
  const runScripts = $derived($activeScripts?.run ?? []);

  // (Re-)read the owning repo's scripts config whenever the repo under the
  // selection changes, so the menu reflects the file without a manual refresh.
  $effect(() => {
    const repo = $activeRepo;
    if (repo) refreshScripts(repo.path);
  });

  async function start(name: string) {
    const repo = $activeRepo;
    const w = wt;
    if (!repo || !w) return;
    error = "";
    try {
      await api.runScript(repo.path, w, name);
      setMainView("run"); // surface the output as it starts
    } catch (e) {
      // The header row can only fit a short label — the full error goes to a
      // toast (same inline-visibility bar as the git panel's errors).
      error = String(e);
      toastError(String(e));
    }
  }

  async function stop() {
    const w = wt;
    if (!w) return;
    error = "";
    try {
      await api.stopScript(w);
    } catch (e) {
      error = String(e);
      toastError(String(e));
    }
  }
</script>

{#if wt && (runScripts.length > 0 || running)}
  {#if running}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="sm"
            variant="ghost"
            class="h-8 gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            onclick={stop}
            aria-label="Stop script"
          >
            <Square class="size-3.5 fill-current" />
            {$activeScriptRun?.name}
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Stop “{$activeScriptRun?.name}”</Tooltip.Content>
    </Tooltip.Root>
  {:else if runScripts.length === 1 && runScripts[0]}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="sm"
            variant="ghost"
            class="h-8 gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            onclick={() => runScripts[0] && start(runScripts[0].name)}
            aria-label="Run script"
          >
            <Play class="size-3.5 fill-current" />
            Run
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>{runScripts[0].command}</Tooltip.Content>
    </Tooltip.Root>
  {:else}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="sm"
            variant="ghost"
            class="h-8 gap-1 text-sm text-muted-foreground hover:text-foreground"
            aria-label="Run a script"
          >
            <Play class="size-3.5 fill-current" />
            Run
            <ChevronDown class="size-3.5" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        {#each runScripts as s (s.name)}
          <DropdownMenu.Item onclick={() => start(s.name)}>
            <span class="font-medium">{s.name}</span>
            <span class="ml-2 truncate text-xs text-muted-foreground">{s.command}</span>
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
  {#if error}
    <!-- whitespace-nowrap: a header row label must not wrap (overrides the shared
         .error-text pre-wrap). -->
    <span class="error-text whitespace-nowrap" title={error}>script failed to start</span>
  {/if}
{/if}
