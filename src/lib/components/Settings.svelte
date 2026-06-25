<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import * as Tabs from "$lib/components/ui/tabs";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Switch } from "$lib/components/ui/switch";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import * as api from "../api";
  import type { ConnectorInfo } from "../types";
  import {
    font,
    FONTS,
    theme,
    THEMES,
    systemPromptAppend,
    connectorsByWorktree,
    selectedWorktree,
    sessionStatus,
    sessionByWorktree,
    setStatus,
    globalConnectorPrefs,
    setGlobalConnectorPref,
    mcpServersJson,
    mcpStatus,
    agentsJson,
  } from "../stores";

  let mcpError = $state("");

  // Trigger label = the currently-selected option's display label.
  const themeLabel = $derived(THEMES.find((t) => t.id === $theme)?.label ?? "Theme");
  const fontLabel = $derived(FONTS.find((f) => f.id === $font)?.label ?? "Font");

  // Connectors are GLOBAL, but the live catalog + toggles need a running session.
  // View the selected worktree's session if alive, else any session that has
  // already reported connectors. Toggles persist globally and apply to every
  // live session; future sessions converge on their own `connectors` event.
  const alive = (wt: string) => $sessionStatus[wt] === "ready" || $sessionStatus[wt] === "busy";
  const sourceWt = $derived.by(() => {
    const sel = $selectedWorktree;
    if (sel && alive(sel)) return sel;
    for (const [wt, list] of Object.entries($connectorsByWorktree)) if (list.length) return wt;
    return sel ?? null;
  });
  const servers = $derived<ConnectorInfo[]>(
    sourceWt ? ($connectorsByWorktree[sourceWt] ?? []) : [],
  );
  const requested = new Set<string>();

  // This component only mounts while the Settings page is shown, so these run on
  // open: ensure a session is feeding the catalog, then (re-)request it (the
  // ready-time broadcast can race the listener — mirrors ModelSelector).
  $effect(() => {
    const sel = $selectedWorktree;
    if (sel && !alive(sel)) {
      api
        .startSession(sel, { resume: $sessionByWorktree[sel] })
        .then(() => setStatus(sel, "ready"))
        .catch(() => {});
    }
  });
  $effect(() => {
    if (!sourceWt || !alive(sourceWt)) return;
    if (servers.length === 0 && !requested.has(sourceWt)) {
      requested.add(sourceWt);
      api.requestConnectors(sourceWt);
    }
  });

  const aliveWorktrees = () => Object.keys($sessionStatus).filter(alive);

  // Per-connector "reconnecting" spinner. Cleared whenever a fresh connector list
  // arrives (the provider re-publishes after every reconnect attempt, success or
  // fail), with a timeout fallback in case no event comes back.
  let reconnecting = $state<Record<string, boolean>>({});
  $effect(() => {
    void servers; // re-run when the connector list updates → the attempt resolved
    reconnecting = {};
  });

  function statusBadge(status: ConnectorInfo["status"]): {
    variant: "default" | "secondary" | "destructive" | "outline";
    label: string;
  } {
    switch (status) {
      case "connected":
        return { variant: "default", label: "connected" };
      case "disabled":
        return { variant: "secondary", label: "disabled" };
      case "failed":
        return { variant: "destructive", label: "failed" };
      case "needs-auth":
        return { variant: "outline", label: "needs auth" };
      default:
        return { variant: "secondary", label: "pending" };
    }
  }

  function checked(s: ConnectorInfo): boolean {
    return $globalConnectorPrefs[s.name] ?? s.status !== "disabled";
  }
  function toggle(s: ConnectorInfo, enabled: boolean) {
    setGlobalConnectorPref(s.name, enabled);
    for (const wt of aliveWorktrees()) api.toggleConnector(wt, s.name, enabled);
  }
  function reconnect(name: string) {
    const wts = aliveWorktrees();
    if (wts.length === 0) return;
    reconnecting = { ...reconnecting, [name]: true };
    for (const wt of wts) api.reconnectConnector(wt, name);
    // Fallback: clear the spinner even if no connectors event comes back.
    setTimeout(() => {
      if (reconnecting[name]) {
        const next = { ...reconnecting };
        delete next[name];
        reconnecting = next;
      }
    }, 8000);
  }

  // Apply the edited MCP JSON to the selected worktree's live session. An empty
  // body clears dynamic servers; invalid JSON is reported, not sent.
  function applyMcp() {
    mcpError = "";
    const raw = $mcpServersJson.trim();
    let parsed: Record<string, unknown> = {};
    if (raw) {
      try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("must be a JSON object");
        parsed = v;
      } catch (e) {
        mcpError = `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
    }
    const wt = $selectedWorktree;
    if (wt) api.setMcpServers(wt, parsed);
  }
</script>

<div class="settings-page">
  <div class="settings-inner">
    <Tabs.Root value="appearance">
      <Tabs.List>
        <Tabs.Trigger value="appearance">Appearance</Tabs.Trigger>
        <Tabs.Trigger value="connectors">Connectors</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="appearance" class="pt-4">
        <div class="flex max-w-md flex-col gap-4">
          <div class="flex items-center justify-between gap-4">
            <span class="text-sm text-muted-foreground">Theme</span>
            <Select.Root type="single" value={$theme} onValueChange={(v) => v && theme.set(v)}>
              <Select.Trigger class="w-44" aria-label="Color theme">{themeLabel}</Select.Trigger>
              <Select.Content align="end">
                {#each THEMES as t (t.id)}
                  <Select.Item value={t.id} label={t.label}>{t.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>

          <div class="flex items-center justify-between gap-4">
            <span class="text-sm text-muted-foreground">Font</span>
            <Select.Root type="single" value={$font} onValueChange={(v) => v && font.set(v)}>
              <Select.Trigger class="w-44" aria-label="UI font">{fontLabel}</Select.Trigger>
              <Select.Content align="end">
                {#each FONTS as f (f.id)}
                  <Select.Item value={f.id} label={f.label}>{f.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-sm text-muted-foreground">Custom system prompt</span>
            <Textarea
              bind:value={$systemPromptAppend}
              rows={3}
              placeholder="Appended to the default prompt (e.g. coding conventions)…"
              class="resize-none text-sm"
              aria-label="Custom system prompt append"
            />
            <span class="text-muted-foreground text-xs">Applies to newly started sessions.</span>
          </div>

          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between">
              <span class="text-sm text-muted-foreground">MCP servers (JSON)</span>
              {#if $mcpStatus.length}
                <span class="text-muted-foreground text-xs">
                  {$mcpStatus.map((s) => `${s.name}: ${s.status}`).join(" · ")}
                </span>
              {/if}
            </div>
            <Textarea
              bind:value={$mcpServersJson}
              rows={4}
              placeholder={'{\n  "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp"] }\n}'}
              class="resize-none font-mono text-xs"
              aria-label="MCP servers JSON config"
            />
            {#if mcpError}
              <span class="text-destructive text-xs">{mcpError}</span>
            {/if}
            <div class="flex items-center justify-between gap-2">
              <span class="text-muted-foreground text-xs">
                Saved for new sessions; Apply updates the current one live.
              </span>
              <Button
                size="sm"
                variant="outline"
                class="h-7 text-xs"
                disabled={!$selectedWorktree}
                onclick={applyMcp}
              >
                Apply
              </Button>
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-sm text-muted-foreground">Subagents (JSON)</span>
            <Textarea
              bind:value={$agentsJson}
              rows={4}
              placeholder={'{\n  "reviewer": { "description": "Reviews code", "prompt": "You are a strict reviewer.", "tools": ["Read", "Grep"] }\n}'}
              class="resize-none font-mono text-xs"
              aria-label="Subagent definitions JSON"
            />
            <span class="text-muted-foreground text-xs">
              Applies to new sessions; repo <code>.claude/agents</code> load automatically.
            </span>
          </div>
        </div>
      </Tabs.Content>

      <Tabs.Content value="connectors" class="pt-4">
        <div class="mb-2 flex items-baseline justify-between">
          <span class="text-sm text-muted-foreground">
            Connectors this instance can use — changes apply to every repo.
          </span>
        </div>

        {#if servers.length === 0}
          <p class="py-3 text-sm text-muted-foreground">
            {sourceWt && alive(sourceWt)
              ? "No connectors reported for this session."
              : "Start a session (select a worktree) to view connectors."}
          </p>
        {:else}
          <div class="flex flex-col gap-1">
            {#each servers as s (s.name)}
              {@const badge = statusBadge(s.status)}
              <Collapsible.Root class="rounded-md border border-border">
                <div class="flex items-center gap-2 px-2.5 py-2">
                  <Collapsible.Trigger
                    class="flex min-w-0 flex-1 items-center gap-2 text-left"
                    disabled={s.tools.length === 0}
                  >
                    {#if s.tools.length}<ChevronDown class="size-3.5 shrink-0 opacity-60" />{/if}
                    <span class="truncate text-sm font-medium">{s.name}</span>
                    <Badge variant={badge.variant} class="shrink-0">{badge.label}</Badge>
                    {#if s.tools.length}
                      <span class="shrink-0 text-xs text-muted-foreground">{s.tools.length} tools</span>
                    {/if}
                  </Collapsible.Trigger>

                  {#if s.status === "failed" || s.status === "needs-auth"}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Reconnect"
                      disabled={reconnecting[s.name]}
                      onclick={() => reconnect(s.name)}
                    >
                      <RotateCw class="size-3.5 {reconnecting[s.name] ? 'animate-spin' : ''}" />
                    </Button>
                  {/if}
                  <Switch checked={checked(s)} onCheckedChange={(v) => toggle(s, v)} aria-label="Enable {s.name}" />
                </div>

                {#if (s.status === "failed" || s.status === "needs-auth") && s.error}
                  <div class="border-t border-border px-2.5 py-1 text-xs text-destructive">{s.error}</div>
                {/if}

                {#if s.tools.length}
                  <Collapsible.Content>
                    <div class="border-t border-border px-2.5 py-1.5">
                      {#each s.tools as t (t.name)}
                        <div class="flex items-center gap-2 py-0.5">
                          <span class="truncate font-mono text-xs">{t.name}</span>
                          {#if t.readOnly}<Badge variant="outline" class="shrink-0">read-only</Badge>{/if}
                          {#if t.destructive}<Badge variant="destructive" class="shrink-0">destructive</Badge>{/if}
                        </div>
                      {/each}
                    </div>
                  </Collapsible.Content>
                {/if}
              </Collapsible.Root>
            {/each}
          </div>
        {/if}
      </Tabs.Content>
    </Tabs.Root>
  </div>
</div>
