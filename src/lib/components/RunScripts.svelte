<script lang="ts" module>
  // The listener-poll in-flight latch — module scope so it holds across
  // remounts/HMR too (see the poll effect below for why it exists).
  let listenerPollInFlight = false;
</script>

<script lang="ts">
  // Header Run control for the repo's `.trickshot/settings.json` run scripts
  // (the Conductor pattern): one script → a plain Run/Stop button; several →
  // Run opens a menu; NONE → the button opens the scripts EDITOR (the
  // ScriptsEditorDialog settings form), so the feature is discoverable before
  // the config exists. While a script runs the button turns into Stop and the
  // Run tab (ViewToggle) shows its live output. Feature component (couples to
  // stores/api by design).
  import {
    activeListeners,
    activeRepo,
    activeScriptRun,
    activeScripts,
    setAllListeners,
    setRunOpen,
    refreshScripts,
    selectedWorktree,
  } from "../stores";
  import * as api from "../api";
  import { toastError } from "../toast";
  import AnsiText from "./AnsiText.svelte";
  import ScriptsEditorDialog from "./ScriptsEditorDialog.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import Play from "@lucide/svelte/icons/play";
  import Square from "@lucide/svelte/icons/square";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import FilePen from "@lucide/svelte/icons/file-pen";
  import Globe from "@lucide/svelte/icons/globe";

  let error = $state("");

  // The scripts editor dialog (form UI + load/save live in the component).
  let editorOpen = $state(false);
  function openEditor() {
    editorOpen = true;
  }

  // ---- live localhost servers (the running-ports chips) ----
  // Coarse poll of `list_listeners` while the header is mounted — the sweep
  // is scoped in Rust to trickshot-spawned process trees (no lsof at all when
  // nothing is running), so a tick is cheap; the chips render the SELECTED
  // worktree's slice. The MODULE-scoped in-flight latch keeps sweeps from
  // ever overlapping (the stuck-folder-picker incident) — a skipped tick just
  // means slightly staler chips.
  const LISTENER_POLL_MS = 5000;
  $effect(() => {
    let stale = false;
    const poll = () => {
      if (listenerPollInFlight) return;
      listenerPollInFlight = true;
      api.listListeners().then(
        (rows) => {
          listenerPollInFlight = false;
          if (!stale) setAllListeners(rows);
        },
        () => {
          listenerPollInFlight = false;
        },
      );
    };
    poll();
    const timer = setInterval(poll, LISTENER_POLL_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  });
  // One chip per PORT (a server may hold several sockets), ascending.
  const ports = $derived(
    [...new Map($activeListeners.map((l) => [l.port, l])).values()].sort(
      (a, b) => a.port - b.port,
    ),
  );

  const wt = $derived($selectedWorktree);
  const running = $derived($activeScriptRun?.status === "running");
  const runScripts = $derived($activeScripts?.run ?? []);
  // The hover preview's live tail: the run's last few output lines — enough
  // to read the app's state (compiling, listening on :3000, crashing) at a
  // glance without opening the Run tab.
  const tail = $derived(($activeScriptRun?.output ?? []).slice(-6));

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
      setRunOpen(true); // surface the output widget as it starts
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

{#if wt}
  <!-- Live localhost servers rooted in this worktree — click opens the
       browser (the open_url hop; target=_blank is dead in the webview). -->
  {#each ports as l (l.port)}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="sm"
            variant="ghost"
            class="h-8 gap-1 px-2 font-mono text-sm text-muted-foreground hover:text-foreground"
            aria-label="Open localhost:{l.port}"
            onclick={() => void api.openUrl(`http://localhost:${l.port}`).catch(() => {})}
          >
            <Globe class="size-3.5" />:{l.port}
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>{l.command} (pid {l.pid}) — open http://localhost:{l.port}</Tooltip.Content>
    </Tooltip.Root>
  {/each}
  {#if !running && runScripts.length === 0}
    <!-- No scripts configured yet: the Run button IS the way in — it opens
         the settings editor (the Conductor onboarding flow). -->
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            size="sm"
            variant="ghost"
            class="h-8 gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            onclick={openEditor}
            aria-label="Configure run scripts"
          >
            <Play class="size-3.5 fill-current" />
            Run
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>No run scripts yet — click to configure .trickshot/settings.json</Tooltip.Content>
    </Tooltip.Root>
  {:else if running}
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
      <!-- The state preview: what the running app is DOING right now (live
           output tail), not just its name — click stops it. -->
      <Tooltip.Content align="end" class="items-stretch p-2.5">
        <div class="run-state">
          <div class="section-label">{$activeScriptRun?.name} — running</div>
          {#if tail.length > 0}
            <div class="run-state-tail">
              {#each tail as line, i (i)}
                <div class="run-state-line"><AnsiText text={line} /></div>
              {/each}
            </div>
          {:else}
            <div class="run-state-empty">no output yet</div>
          {/if}
          <div class="run-state-hint">click to stop · Run tab has the full log</div>
        </div>
      </Tooltip.Content>
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
            oncontextmenu={(e: MouseEvent) => {
              e.preventDefault();
              openEditor();
            }}
            aria-label="Run script"
          >
            <Play class="size-3.5 fill-current" />
            Run
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>{runScripts[0].command} · right-click to edit</Tooltip.Content>
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
        <DropdownMenu.Separator />
        <DropdownMenu.Item onclick={openEditor}>
          <FilePen class="size-3.5" />
          Edit run scripts…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
  {#if error}
    <!-- whitespace-nowrap: a header row label must not wrap (overrides the shared
         .error-text pre-wrap). -->
    <span class="error-text whitespace-nowrap" title={error}>script failed to start</span>
  {/if}
{/if}

<ScriptsEditorDialog open={editorOpen} onOpenChange={(v) => (editorOpen = v)} />

<style>
  /* The running-state hover card (tooltip content) — the UsageIndicator
     .usage-detail precedent: one-component tooltip content stays scoped. */
  .run-state {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 220px;
    max-width: 380px;
  }
  .run-state-tail {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-family: var(--app-font-mono);
    font-size: var(--text-2xs);
    line-height: 1.5;
    color: var(--app-text);
  }
  .run-state-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }
  .run-state-empty,
  .run-state-hint {
    font-size: var(--text-2xs);
    color: var(--app-dim);
  }
</style>
