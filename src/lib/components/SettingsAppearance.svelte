<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as api from "../api";
  import {
    CHAT_SURFACE,
    font,
    setFont,
    FONTS,
    theme,
    setTheme,
    THEMES,
    TERMINAL_FONT_SIZES,
    terminalFontSize,
    setTerminalFontSize,
    uniformType,
    setUniformType,
    systemPromptAppend,
    selectedWorktree,
    mcpServersJson,
    mcpStatus,
    agentsJson,
  } from "../stores";
  import { applyTerminalFontSize } from "../terminal";

  // Persist + live-apply (cached xterms refit; terminal.ts can't subscribe).
  function pickTerminalFontSize(v: string) {
    const px = Number(v);
    setTerminalFontSize(px);
    applyTerminalFontSize(px);
  }

  let mcpError = $state("");

  // Trigger label = the currently-selected option's display label.
  const themeLabel = $derived(THEMES.find((t) => t.id === $theme)?.label ?? "Theme");
  const fontLabel = $derived(FONTS.find((f) => f.id === $font)?.label ?? "Font");

  // Compact MCP status: "<N> servers · <n> connected · <n> needs-auth · …".
  // The raw per-server list (one config can expose dozens) is too long to show
  // inline, so collapse it to counts by status (most-common first).
  const mcpSummary = $derived.by(() => {
    const list = $mcpStatus;
    if (!list.length) return "";
    const counts: Record<string, number> = {};
    for (const s of list) counts[s.status] = (counts[s.status] ?? 0) + 1;
    const parts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, n]) => `${n} ${status}`);
    return `${list.length} server${list.length === 1 ? "" : "s"} · ${parts.join(" · ")}`;
  });

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

<div class="flex flex-col gap-4">
  <div class="flex items-center justify-between gap-4">
    <span class="text-sm text-muted-foreground">Theme</span>
    <Select.Root type="single" value={$theme} onValueChange={(v) => v && setTheme(v)}>
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
    <Select.Root type="single" value={$font} onValueChange={(v) => v && setFont(v)}>
      <Select.Trigger class="w-44" aria-label="UI font">{fontLabel}</Select.Trigger>
      <Select.Content align="end">
        {#each FONTS as f (f.id)}
          <Select.Item value={f.id} label={f.label}>{f.label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <div class="flex items-center justify-between gap-4">
    <span class="text-sm text-muted-foreground">Terminal font size</span>
    <Select.Root type="single" value={String($terminalFontSize)} onValueChange={(v) => v && pickTerminalFontSize(v)}>
      <Select.Trigger class="w-44" aria-label="Terminal font size">{$terminalFontSize}px</Select.Trigger>
      <Select.Content align="end">
        {#each TERMINAL_FONT_SIZES as s (s)}
          <Select.Item value={String(s)} label="{s}px">{s}px</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <div class="flex items-center justify-between gap-4">
    <div class="flex flex-col gap-0.5">
      <span class="text-sm text-muted-foreground">Match terminal text size</span>
      <span class="text-xs text-muted-foreground">
        Every UI label renders at the terminal's size ({$terminalFontSize}px) — one glyph size, like
        a real TUI.
      </span>
    </div>
    <Switch
      checked={$uniformType}
      onCheckedChange={setUniformType}
      aria-label="Match terminal text size"
    />
  </div>

  {#if CHAT_SURFACE === "cli"}
    <!-- Truth-in-labeling: the knobs below configure SIDECAR sessions, which
         CLI-first chat never starts — the CLI reads your own Claude Code
         settings instead. Kept visible (they still apply to the preserved GUI
         surface) but say so, rather than looking functional. -->
    <p class="text-muted-foreground text-xs">
      The settings below apply only to GUI (sidecar) sessions — CLI chat uses your own Claude Code
      configuration (<code>~/.claude</code>, <code>CLAUDE.md</code>, <code>.mcp.json</code>).
    </p>
  {/if}

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
        <span class="text-muted-foreground text-xs">{mcpSummary}</span>
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
