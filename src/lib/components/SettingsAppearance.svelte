<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import {
    allThemes,
    deleteCustomTheme,
    disabledThemes,
    font,
    setFont,
    FONTS,
    setThemeDisabled,
    theme,
    setTheme,
    themeOptions,
    TERMINAL_FONT_SIZES,
    terminalFontSize,
    setTerminalFontSize,
    uniformType,
    setUniformType,
    cursorTrailEnabled,
    setCursorTrailEnabled,
  } from "../stores";
  import { THEMES as BUILTIN_THEMES, type Theme } from "../themes";
  import { applyTerminalFontSize } from "../terminal";
  import ThemeEditorDialog from "./ThemeEditorDialog.svelte";

  // Persist + live-apply (cached xterms refit; terminal.ts can't subscribe).
  function pickTerminalFontSize(v: string) {
    const px = Number(v);
    setTerminalFontSize(px);
    applyTerminalFontSize(px);
  }

  // Trigger label = the currently-selected option's display label.
  const themeLabel = $derived($themeOptions.find((t) => t.id === $theme)?.label ?? "Theme");
  const fontLabel = $derived(FONTS.find((f) => f.id === $font)?.label ?? "Font");

  // ---- Theme gallery state ----
  const builtinIds = new Set(BUILTIN_THEMES.map((t) => t.id));
  /** The swatch strip's sample: the keys that read a theme at a glance. */
  const SWATCH_KEYS = [
    "bg",
    "surface",
    "border",
    "text",
    "accent",
    "danger",
    "success",
    "warning",
  ] as const;
  let editorOpen = $state(false);
  let editingTheme = $state<Theme | null>(null);
  let deleteTarget = $state<Theme | null>(null);

  function openCreate() {
    editingTheme = null;
    editorOpen = true;
  }
  function openEdit(t: Theme) {
    editingTheme = t;
    editorOpen = true;
  }
  function confirmDelete() {
    if (deleteTarget) deleteCustomTheme(deleteTarget.id);
    deleteTarget = null;
  }
</script>

<div class="flex flex-col gap-4">
  <div class="flex items-center justify-between gap-4">
    <span class="text-sm text-muted-foreground">Theme</span>
    <Select.Root type="single" value={$theme} onValueChange={(v) => v && setTheme(v)}>
      <Select.Trigger class="w-44" aria-label="Color theme">{themeLabel}</Select.Trigger>
      <Select.Content align="end">
        {#each $themeOptions as t (t.id)}
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

  <!-- Theme gallery: every theme (built-in + custom) as a swatch card —
       click to apply, switch to show/hide it in the pickers, edit/delete for
       custom ones. -->
  <div class="mt-2 flex flex-col gap-2">
    <div class="flex items-center justify-between gap-4">
      <span class="section-label">Themes</span>
      <Button size="sm" variant="outline" class="h-7 text-xs" onclick={openCreate}>
        <Plus class="size-3.5" /> New theme
      </Button>
    </div>
    <div class="theme-grid">
      {#each $allThemes as t (t.id)}
        {@const isActive = $theme === t.id}
        {@const isCustom = !builtinIds.has(t.id)}
        {@const isEnabled = !$disabledThemes.includes(t.id)}
        <Card.Root class="theme-card gap-2 p-3" data-active={isActive ? "" : undefined}>
          <button class="theme-card-apply" onclick={() => setTheme(t.id)} title="Apply {t.label}">
            <span class="theme-card-name">
              {t.label}
              {#if isActive}<span class="theme-card-active">active</span>{/if}
            </span>
            <!-- Swatch strip: dynamic user/theme colors, inline by necessity. -->
            <span class="theme-swatches">
              {#each SWATCH_KEYS as key (key)}
                <span class="theme-swatch" style="background: {t.palette[key]};" title={key}
                ></span>
              {/each}
            </span>
          </button>
          <div class="theme-card-foot">
            {#if isActive}
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props })}
                    <span {...props}>
                      <Switch size="sm" checked={true} disabled aria-label="Shown in picker" />
                    </span>
                  {/snippet}
                </Tooltip.Trigger>
                <Tooltip.Content>The active theme can't be hidden</Tooltip.Content>
              </Tooltip.Root>
            {:else}
              <Switch
                size="sm"
                checked={isEnabled}
                onCheckedChange={(v) => setThemeDisabled(t.id, !v)}
                aria-label="Shown in picker"
              />
            {/if}
            <span class="theme-foot-label">{isEnabled ? "in picker" : "hidden"}</span>
            {#if isCustom}
              <span class="flex-1"></span>
              <Button
                size="icon-sm"
                variant="ghost"
                class="size-6"
                aria-label="Edit {t.label}"
                onclick={() => openEdit(t)}
              >
                <Pencil class="size-3" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                class="size-6"
                aria-label="Delete {t.label}"
                onclick={() => (deleteTarget = t)}
              >
                <Trash2 class="size-3" />
              </Button>
            {/if}
          </div>
        </Card.Root>
      {/each}
    </div>
  </div>

  <!-- Agent configuration (system prompt, MCP servers, subagents, permissions)
       lives in your own Claude Code setup — ~/.claude, CLAUDE.md, .mcp.json —
       which the CLI picks up directly; the app adds no layer on top. -->
</div>

<ThemeEditorDialog
  open={editorOpen}
  onOpenChange={(v) => (editorOpen = v)}
  editing={editingTheme}
/>

<Dialog.Root open={deleteTarget !== null} onOpenChange={(v) => !v && (deleteTarget = null)}>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Delete theme</Dialog.Title>
      <Dialog.Description>
        Delete “{deleteTarget?.label}”? {deleteTarget && $theme === deleteTarget.id
          ? "It's the active theme — the default takes over."
          : ""}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => (deleteTarget = null)}>Cancel</Button>
      <Button variant="destructive" onclick={confirmDelete}>Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Gallery layout: one-component structural CSS (split-by-reach). */
  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
  }
  :global(.theme-card[data-active]) {
    /* The focus-tint recipe (text-mix, not accent) — stronger than a hover
       so "active" still reads, but never a random accent hue. */
    border-color: color-mix(in oklch, var(--app-text) 45%, var(--app-border));
  }
  .theme-card-apply {
    display: flex;
    flex-direction: column;
    gap: 8px;
    text-align: left;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .theme-card-name {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .theme-card-active {
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--app-accent);
  }
  .theme-swatches {
    display: flex;
    gap: 3px;
  }
  .theme-swatch {
    width: 16px;
    height: 16px;
    border-radius: var(--radius-2xs);
    border: 1px solid var(--app-border);
  }
  .theme-card-foot {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .theme-foot-label {
    font-size: var(--text-2xs);
    color: var(--app-dim);
  }
</style>
