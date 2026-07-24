<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import {
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
    cursorTrailEnabled,
    setCursorTrailEnabled,
  } from "../stores";
  import { applyTerminalFontSize } from "../terminal";

  // Persist + live-apply (cached xterms refit; terminal.ts can't subscribe).
  function pickTerminalFontSize(v: string) {
    const px = Number(v);
    setTerminalFontSize(px);
    applyTerminalFontSize(px);
  }

  // Trigger label = the currently-selected option's display label.
  const themeLabel = $derived(THEMES.find((t) => t.id === $theme)?.label ?? "Theme");
  const fontLabel = $derived(FONTS.find((f) => f.id === $font)?.label ?? "Font");
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

  <div class="flex items-center justify-between gap-4">
    <div class="flex flex-col gap-0.5">
      <span class="text-sm text-muted-foreground">Cursor trail</span>
      <span class="text-xs text-muted-foreground">
        The pointer's pixel wake on the terminal backdrop.
      </span>
    </div>
    <Switch
      checked={$cursorTrailEnabled}
      onCheckedChange={setCursorTrailEnabled}
      aria-label="Cursor trail"
    />
  </div>

  <!-- Agent configuration (system prompt, MCP servers, subagents, permissions)
       lives in your own Claude Code setup — ~/.claude, CLAUDE.md, .mcp.json —
       which the CLI picks up directly; the app adds no layer on top. -->
</div>
