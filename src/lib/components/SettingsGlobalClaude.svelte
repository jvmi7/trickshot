<script lang="ts">
  // Settings › Global Claude: what's set up in the user's global Claude Code
  // config (~/.claude + the user-scope MCP servers from ~/.claude.json), with
  // in-place editing for exactly settings.json + the global CLAUDE.md. Disk
  // state is fetched on demand into LOCAL state — deliberately not a store:
  // the app keeps no config cache (the CLI owns these files; see the
  // ARCHITECTURE.md Boundaries note). Feature component (calls api).
  import * as api from "../api";
  import type { ClaudeEntry, ClaudeOverview } from "../types";
  import { listMcpServers, summarizeClaudeSettings } from "../claudeConfig";
  import { relativeTime } from "$lib/utils";
  import { badgeVariants } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Dialog from "$lib/components/ui/dialog";
  import Bot from "@lucide/svelte/icons/bot";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import FileText from "@lucide/svelte/icons/file-text";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Plug from "@lucide/svelte/icons/plug";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import SquareSlash from "@lucide/svelte/icons/square-slash";
  import Sparkles from "@lucide/svelte/icons/sparkles";

  let overview = $state<ClaudeOverview | null>(null);
  let loading = $state(false);
  let loadError = $state("");

  /** Which editable file has its inline editor open (one at a time). */
  let editing = $state<"settings.json" | "CLAUDE.md" | null>(null);
  let draft = $state("");
  let saveError = $state("");
  let saving = $state(false);

  /** Read-only viewer dialog for agents/commands/skills entries. */
  let viewer = $state<{ title: string; text: string } | null>(null);

  let showLocal = $state(false);
  let showProjects = $state(false);

  const settingsSummary = $derived(summarizeClaudeSettings(overview?.settings ?? null));
  const mcpRows = $derived(listMcpServers(overview?.mcp_servers ?? null));
  const chipClass = badgeVariants({ variant: "outline" });

  async function refresh() {
    loading = true;
    loadError = "";
    try {
      overview = await api.claudeConfigOverview();
    } catch (e) {
      loadError = String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void refresh();
  });

  function openEditor(file: "settings.json" | "CLAUDE.md", text: string | null) {
    editing = file;
    draft = text ?? "";
    saveError = "";
  }

  async function save() {
    if (!editing) return;
    saving = true;
    saveError = "";
    try {
      await api.writeClaudeFile(editing, draft);
      editing = null;
      await refresh();
    } catch (e) {
      saveError = String(e);
    } finally {
      saving = false;
    }
  }

  async function openViewer(entry: ClaudeEntry) {
    try {
      viewer = { title: entry.name, text: await api.readClaudeFile(entry.file) };
    } catch (e) {
      viewer = { title: entry.name, text: String(e) };
    }
  }
</script>

<div class="gc">
  <!-- Header: where this lives + refresh (external edits — the CLI itself,
       /config — are expected; last write wins, refresh to re-sync). -->
  <div class="gc-head">
    <span class="gc-root" title="Claude Code's own config — the app adds no layer on top">
      {overview?.root ?? "~/.claude"}
    </span>
    <Button size="sm" variant="ghost" class="h-7 text-xs" disabled={loading} onclick={refresh}>
      <RefreshCw class="size-3" /> Refresh
    </Button>
  </div>
  {#if loadError}
    <p class="error-text">{loadError}</p>
  {/if}

  {#if overview}
    <!-- settings.json -->
    <section class="gc-section">
      <div class="gc-section-head">
        <span class="section-label">settings.json</span>
        {#if editing !== "settings.json"}
          <Button
            size="sm"
            variant="ghost"
            class="h-6 text-xs"
            onclick={() => openEditor("settings.json", overview?.settings ?? "{\n}\n")}
          >
            <Pencil class="size-3" /> Edit
          </Button>
        {/if}
      </div>
      {#if editing === "settings.json"}
        <Textarea
          bind:value={draft}
          rows={12}
          class="resize-none font-mono text-xs"
          aria-label="settings.json editor"
        />
        {#if saveError}
          <p class="error-text">{saveError}</p>
        {/if}
        <div class="gc-editor-actions">
          <Button size="sm" variant="secondary" onclick={() => (editing = null)}>Cancel</Button>
          <Button size="sm" disabled={saving} onclick={save}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      {:else if settingsSummary.invalid}
        <p class="error-text">settings.json exists but isn't valid JSON — edit it to fix.</p>
      {:else if settingsSummary.chips.length > 0}
        <div class="gc-chips">
          {#each settingsSummary.chips as chip (chip.label)}
            <span class={chipClass}>
              {chip.label}{chip.value != null ? `: ${chip.value}` : ""}
            </span>
          {/each}
        </div>
      {:else}
        <p class="gc-empty empty-state">
          {overview.settings == null ? "No settings.json yet." : "No recognized settings set."}
        </p>
      {/if}

      {#if overview.settings_local != null}
        <button class="gc-disclose" onclick={() => (showLocal = !showLocal)}>
          {#if showLocal}<ChevronDown class="size-3" />{:else}<ChevronRight class="size-3" />{/if}
          settings.local.json — machine-local overrides (read-only)
        </button>
        {#if showLocal}
          <pre class="gc-pre">{overview.settings_local}</pre>
        {/if}
      {/if}
    </section>

    <!-- Global CLAUDE.md -->
    <section class="gc-section">
      <div class="gc-section-head">
        <span class="section-label">Global CLAUDE.md</span>
        {#if editing !== "CLAUDE.md"}
          <Button
            size="sm"
            variant="ghost"
            class="h-6 text-xs"
            onclick={() => openEditor("CLAUDE.md", overview?.claude_md ?? "")}
          >
            <Pencil class="size-3" />
            {overview.claude_md == null ? "Create" : "Edit"}
          </Button>
        {/if}
      </div>
      {#if editing === "CLAUDE.md"}
        <Textarea
          bind:value={draft}
          rows={14}
          class="resize-none font-mono text-xs"
          aria-label="Global CLAUDE.md editor"
          placeholder="Instructions Claude Code applies to every project…"
        />
        {#if saveError}
          <p class="error-text">{saveError}</p>
        {/if}
        <div class="gc-editor-actions">
          <Button size="sm" variant="secondary" onclick={() => (editing = null)}>Cancel</Button>
          <Button size="sm" disabled={saving} onclick={save}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      {:else if overview.claude_md != null}
        <pre class="gc-pre gc-pre-tall">{overview.claude_md}</pre>
      {:else}
        <p class="gc-empty empty-state">
          No global CLAUDE.md — instructions here apply to every project.
        </p>
      {/if}
    </section>

    <!-- Agents / Commands / Skills -->
    {#each [{ label: "Agents", icon: Bot, entries: overview.agents, hint: "~/.claude/agents/*.md" }, { label: "Commands", icon: SquareSlash, entries: overview.commands, hint: "~/.claude/commands/**/*.md" }, { label: "Skills", icon: Sparkles, entries: overview.skills, hint: "~/.claude/skills/*/SKILL.md" }] as group (group.label)}
      <section class="gc-section">
        <div class="gc-section-head">
          <span class="section-label">{group.label}</span>
          <span class="gc-count">{group.entries.length}</span>
        </div>
        {#if group.entries.length === 0}
          <p class="gc-empty empty-state">None yet — add files under {group.hint}.</p>
        {:else}
          <div class="gc-list">
            {#each group.entries as entry (entry.file)}
              <button class="gc-row" onclick={() => openViewer(entry)} title={entry.file}>
                <group.icon class="size-3.5 shrink-0" />
                <span class="gc-row-name">{entry.name}</span>
                {#if entry.modified_ms != null}
                  <span class="gc-row-meta">{relativeTime(entry.modified_ms)}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/each}

    <!-- MCP servers (user scope) -->
    <section class="gc-section">
      <div class="gc-section-head">
        <span class="section-label">MCP servers</span>
        <span class="gc-count">{mcpRows.length}</span>
      </div>
      {#if mcpRows.length === 0}
        <p class="gc-empty empty-state">No user-scope MCP servers.</p>
      {:else}
        <div class="gc-list">
          {#each mcpRows as row (row.name)}
            <div class="gc-row gc-row-static">
              <Plug class="size-3.5 shrink-0" />
              <span class="gc-row-name">{row.name}</span>
              <span class="gc-row-meta gc-row-detail">{row.detail}</span>
            </div>
          {/each}
        </div>
      {/if}
      <p class="gc-note">
        Manage with <code>claude mcp</code> (or a project's <code>.mcp.json</code>) — the CLI
        picks them up directly.
      </p>
    </section>

    <!-- Projects (session store) -->
    <section class="gc-section">
      <button class="gc-disclose" onclick={() => (showProjects = !showProjects)}>
        {#if showProjects}<ChevronDown class="size-3" />{:else}<ChevronRight class="size-3" />{/if}
        <span class="section-label">Projects</span>
        <span class="gc-count">{overview.projects.length}</span>
      </button>
      {#if showProjects}
        {#if overview.projects.length === 0}
          <p class="gc-empty empty-state">No project sessions yet.</p>
        {:else}
          <div class="gc-list">
            {#each overview.projects as p (p.dir)}
              <div class="gc-row gc-row-static">
                <FileText class="size-3.5 shrink-0" />
                <span class="gc-row-name gc-row-detail">{p.dir}</span>
                <span class="gc-row-meta">{p.sessions} session{p.sessions === 1 ? "" : "s"}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </section>
  {:else if loading}
    <p class="gc-empty empty-state">Reading ~/.claude…</p>
  {/if}
</div>

<!-- Read-only entry viewer -->
<Dialog.Root open={viewer !== null} onOpenChange={(v) => !v && (viewer = null)}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{viewer?.title}</Dialog.Title>
    </Dialog.Header>
    <pre class="gc-pre gc-pre-tall">{viewer?.text}</pre>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Section layout is one-component structural CSS (split-by-reach); colors
     and type come from the shared tokens. */
  .gc {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .gc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .gc-root {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--app-dim);
  }
  .gc-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .gc-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .gc-count {
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  .gc-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .gc-empty {
    text-align: left;
  }
  .gc-note {
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  .gc-editor-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .gc-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .gc-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 4px 6px;
    text-align: left;
    font: inherit;
    color: var(--app-text);
    background: none;
    border: none;
    border-radius: var(--radius-xs);
  }
  .gc-row:not(.gc-row-static) {
    cursor: pointer;
    transition: background var(--app-duration-fast);
  }
  .gc-row:not(.gc-row-static):hover {
    background: var(--app-panel-2);
  }
  .gc-row-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-md);
  }
  .gc-row-meta {
    margin-left: auto;
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--app-dim);
  }
  .gc-row-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }
  .gc-disclose {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    font: inherit;
    font-size: var(--text-xs);
    color: var(--app-dim);
    background: none;
    border: none;
    cursor: pointer;
  }
  .gc-disclose:hover {
    color: var(--app-text);
  }
  .gc-pre {
    margin: 0;
    padding: 8px 10px;
    max-height: 200px;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--app-dim);
    background: var(--app-panel);
    border: 1px solid var(--app-border);
    border-radius: var(--radius-sm);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .gc-pre-tall {
    max-height: min(48vh, 480px);
    color: var(--app-text);
  }
</style>
