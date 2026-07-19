<script lang="ts">
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Switch } from "$lib/components/ui/switch";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import * as api from "../api";
  import type { ConnectorInfo } from "../types";
  import {
    CHAT_SURFACE,
    connectorsByWorktree,
    selectedWorktree,
    sessionStatus,
    setStatus,
    globalConnectorPrefs,
    setGlobalConnectorPref,
    ensureSession,
    requestOnce,
  } from "../stores";

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

  // This component only mounts while the Settings page is shown, so these run on
  // open: ensure a session is feeding the catalog, then (re-)request it (the
  // ready-time broadcast can race the listener — mirrors ModelSelector).
  // Instance-scoped one-shot per worktree: a spawn failure flips the status back
  // to `stopped`, which would otherwise re-trigger this effect in a retry loop.
  const sessionTried = new Set<string>();
  $effect(() => {
    // CLI-first (CHAT_SURFACE === "cli"): there is no sidecar to feed this
    // catalog — the CLI owns the session (and its own /mcp management), and
    // spawning a sidecar here would double-own it. The panel is inert.
    if (CHAT_SURFACE === "cli") return;
    const sel = $selectedWorktree;
    // `starting` while the sidecar boots; its `ready` event flips the status
    // (spawn success alone isn't readiness — same contract as activateWorktree).
    if (sel && !alive(sel) && $sessionStatus[sel] !== "starting" && !sessionTried.has(sel)) {
      sessionTried.add(sel);
      setStatus(sel, "starting");
      ensureSession(sel).catch(() => setStatus(sel, "stopped"));
    }
  });
  // Instance-scoped so reopening Settings (a remount) re-requests if the catalog
  // is still empty — the resilience the prior per-mount Set provided.
  const requested = new Set<string>();
  $effect(() => {
    if (CHAT_SURFACE === "cli") return; // no sidecar to ask (see above)
    if (sourceWt && alive(sourceWt) && servers.length === 0) {
      requestOnce(requested, sourceWt, "connectors", api.requestConnectors);
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
  const reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  function reconnect(name: string) {
    const wts = aliveWorktrees();
    if (wts.length === 0) return;
    reconnecting = { ...reconnecting, [name]: true };
    for (const wt of wts) api.reconnectConnector(wt, name);
    // Fallback: clear the spinner even if no connectors event comes back.
    const timer = setTimeout(() => {
      reconnectTimers.delete(timer);
      if (reconnecting[name]) {
        const next = { ...reconnecting };
        delete next[name];
        reconnecting = next;
      }
    }, 8000);
    reconnectTimers.add(timer);
  }
  // Settings unmounts on close — don't leave the 8s fallbacks firing after it.
  $effect(() => () => {
    for (const timer of reconnectTimers) clearTimeout(timer);
    reconnectTimers.clear();
  });
</script>

<div class="mb-2 flex items-baseline justify-between">
  <span class="text-sm text-muted-foreground">
    Connectors this instance can use — changes apply to every repo.
  </span>
</div>

{#if CHAT_SURFACE === "cli"}
  <!-- Truthful empty state: under CLI-first chat no sidecar exists, so a live
       connector catalog can never arrive — "select a worktree" would be a lie.
       Point at the CLI's own management surface instead. -->
  <p class="py-3 text-sm text-muted-foreground">
    Connector status isn't available in CLI chat mode — manage connectors with
    <code>claude mcp</code> (or your project's <code>.mcp.json</code>); the CLI picks them up
    directly.
  </p>
{:else if servers.length === 0}
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
