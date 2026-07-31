<script lang="ts">
  // The project-scripts editor as a SETTINGS FORM (the Vercel project-config
  // pattern): labeled fields with inline hints instead of raw JSON — run
  // commands as name/command rows, setup/archive as single inputs, run_mode
  // as a toggle. Reads/writes `.trickshot/settings.json` through the
  // get_scripts_source/save_scripts_source commands; top-level keys other
  // than `scripts` are preserved on save. Feature component (stores/api).
  import { activeRepo, refreshScripts } from "../stores";
  import * as api from "../api";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Separator } from "$lib/components/ui/separator";
  import { Switch } from "$lib/components/ui/switch";
  import IconButton from "./IconButton.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";

  let { open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void } = $props();

  let setup = $state("");
  let archive = $state("");
  let nonconcurrent = $state(false);
  let runs = $state<{ name: string; command: string }[]>([]);
  let loadNote = $state("");
  let saveError = $state("");
  // The full parsed settings file — save spreads it back so top-level keys
  // beside `scripts` survive a round-trip through the form.
  let base: Record<string, unknown> = {};

  $effect(() => {
    if (open) void load();
  });

  async function load() {
    setup = "";
    archive = "";
    nonconcurrent = false;
    runs = [];
    loadNote = "";
    saveError = "";
    base = {};
    const repo = $activeRepo;
    if (!repo) return;
    try {
      // Missing file → Rust returns the starter template buffer (not written),
      // so a fresh repo opens with sensible prefills.
      const raw = await api.getScriptsSource(repo.path);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>; // narrowed to a plain object above
      }
      const s =
        typeof base.scripts === "object" && base.scripts !== null && !Array.isArray(base.scripts)
          ? (base.scripts as Record<string, unknown>) // same plain-object narrowing
          : {};
      if (typeof s.setup === "string") setup = s.setup;
      if (typeof s.archive === "string") archive = s.archive;
      nonconcurrent = s.run_mode === "nonconcurrent";
      if (typeof s.run === "string") {
        runs = [{ name: "run", command: s.run }];
      } else if (typeof s.run === "object" && s.run !== null && !Array.isArray(s.run)) {
        runs = Object.entries(s.run).flatMap(([name, cmd]) =>
          typeof cmd === "string" ? [{ name, command: cmd }] : [],
        );
      }
    } catch {
      loadNote = "The existing settings file isn't valid JSON — saving will rewrite it.";
    }
    if (runs.length === 0) runs = [{ name: "dev", command: "" }];
  }

  function buildJson(): string {
    const scripts: Record<string, unknown> = {};
    if (setup.trim()) scripts.setup = setup.trim();
    const run: Record<string, string> = {};
    for (const r of runs) {
      const name = r.name.trim();
      const command = r.command.trim();
      if (name && command) run[name] = command;
    }
    if (Object.keys(run).length > 0) scripts.run = run;
    if (archive.trim()) scripts.archive = archive.trim();
    if (nonconcurrent) scripts.run_mode = "nonconcurrent";
    const out: Record<string, unknown> = { ...base, scripts };
    if (Object.keys(scripts).length === 0) delete out.scripts;
    return `${JSON.stringify(out, null, 2)}\n`;
  }

  async function save() {
    const repo = $activeRepo;
    if (!repo) return;
    saveError = "";
    const names = runs.map((r) => r.name.trim()).filter(Boolean);
    if (new Set(names).size !== names.length) {
      saveError = "run command names must be unique";
      return;
    }
    try {
      // Rust re-validates before writing — the file on disk stays loadable.
      await api.saveScriptsSource(repo.path, buildJson());
      await refreshScripts(repo.path);
      onOpenChange(false);
    } catch (e) {
      saveError = String(e);
    }
  }
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header>
      <Dialog.Title>Project scripts</Dialog.Title>
      <Dialog.Description>
        Saved to <code>{$activeRepo?.name ?? ""}/.trickshot/settings.json</code> — commit it to
        share the workflow with your team.
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-2">
        <Label>Run commands</Label>
        {#each runs as r, i (i)}
          <div class="flex items-center gap-2">
            <Input
              class="w-32 shrink-0 font-mono text-sm"
              placeholder="dev"
              aria-label="Command name"
              bind:value={r.name}
            />
            <Input
              class="flex-1 font-mono text-sm"
              placeholder="bun run dev --port $TRICKSHOT_PORT"
              aria-label="Command"
              bind:value={r.command}
            />
            <IconButton
              aria-label="Remove command"
              onclick={() => (runs = runs.filter((_, j) => j !== i))}
            >
              <X />
            </IconButton>
          </div>
        {/each}
        <Button
          variant="ghost"
          size="sm"
          class="self-start gap-1.5 text-muted-foreground hover:text-foreground"
          onclick={() => (runs = [...runs, { name: "", command: "" }])}
        >
          <Plus class="size-3.5" /> Add command
        </Button>
        <p class="text-xs text-muted-foreground">
          Long-running commands behind the header's Run button. Each worktree gets its own port
          block — use <code>$TRICKSHOT_PORT</code> so parallel worktrees never collide.
        </p>
        <div class="mt-1 flex items-center gap-2.5">
          <Switch id="scripts-run-mode" bind:checked={nonconcurrent} />
          <Label for="scripts-run-mode" class="font-normal text-muted-foreground">
            Stop other running commands when one starts
          </Label>
        </div>
      </div>

      <Separator />

      <div class="flex flex-col gap-2">
        <Label for="scripts-setup">Setup command</Label>
        <Input
          id="scripts-setup"
          class="font-mono text-sm"
          placeholder="bun install"
          bind:value={setup}
        />
        <p class="text-xs text-muted-foreground">
          Runs once when a worktree is created — install dependencies, copy <code>.env</code> files.
        </p>
      </div>

      <Separator />

      <div class="flex flex-col gap-2">
        <Label for="scripts-archive">Archive command</Label>
        <Input
          id="scripts-archive"
          class="font-mono text-sm"
          placeholder="docker compose down"
          bind:value={archive}
        />
        <p class="text-xs text-muted-foreground">
          Runs before a workspace is archived — clean up resources that live outside the worktree.
        </p>
      </div>

      {#if loadNote}
        <span class="notice-text">{loadNote}</span>
      {/if}
      {#if saveError}
        <span class="error-text">{saveError}</span>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="secondary" onclick={() => onOpenChange(false)}>Cancel</Button>
      <Button onclick={() => void save()}>Save</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
