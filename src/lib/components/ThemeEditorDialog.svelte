<script lang="ts">
  // Theme editor: create a custom theme (seeded from a duplicate of any
  // existing theme) or edit an existing custom one. 14 plain-color rows get a
  // paired color-well + hex text input; `overlay`/`termGlow` are free CSS
  // value strings (a scrim can be a translucent color function, a glow a
  // text-shadow stack). Save validates via themes.ts › isTheme (the guard the
  // persisted store parses with) and surfaces failures as local error text.
  // Feature component (writes the theme stores).
  import { get } from "svelte/store";
  import {
    addCustomTheme,
    allThemes,
    setTheme,
    theme as activeTheme,
    updateCustomTheme,
  } from "../stores";
  import { isTheme, type Theme, type ThemePalette, uniqueThemeId } from "../themes";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";

  let {
    open,
    onOpenChange,
    editing = null,
  }: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    /** A CUSTOM theme to edit; null = create-new flow. */
    editing?: Theme | null;
  } = $props();

  /** The 14 single-color keys, in palette order, with picker labels. */
  const COLOR_KEYS: { key: keyof ThemePalette; label: string }[] = [
    { key: "bg", label: "Background" },
    { key: "surface", label: "Surface" },
    { key: "surfaceRaised", label: "Surface raised" },
    { key: "border", label: "Border" },
    { key: "text", label: "Text" },
    { key: "textMuted", label: "Text muted" },
    { key: "accent", label: "Accent" },
    { key: "onAccent", label: "On accent" },
    { key: "danger", label: "Danger" },
    { key: "success", label: "Success" },
    { key: "info", label: "Info" },
    { key: "warning", label: "Warning" },
    { key: "special", label: "Special" },
    { key: "selection", label: "Selection" },
  ];
  /** Free CSS value strings — not single colors. */
  const TEXT_KEYS: { key: keyof ThemePalette; label: string; hint: string }[] = [
    { key: "overlay", label: "Overlay", hint: "modal scrim — any CSS color" },
    { key: "termGlow", label: "Terminal glow", hint: "a text-shadow value; “none” disables" },
  ];

  let name = $state("");
  let baseId = $state("");
  let palette = $state<Record<string, string>>({});
  let error = $state("");

  // (Re)seed the working copy each time the dialog opens: the edited theme's
  // palette, or a duplicate of the ACTIVE theme for create-new.
  $effect(() => {
    if (!open) return;
    error = "";
    if (editing) {
      name = editing.label;
      baseId = editing.id;
      palette = { ...editing.palette };
    } else {
      const all = get(allThemes);
      const seed = all.find((t) => t.id === get(activeTheme)) ?? all[0];
      name = "";
      baseId = seed?.id ?? "";
      palette = { ...(seed?.palette ?? {}) };
    }
  });

  const baseLabel = $derived($allThemes.find((t) => t.id === baseId)?.label ?? "Start from");

  /** Create-new only: re-seed the palette from another theme. */
  function pickBase(id: string) {
    baseId = id;
    const seed = $allThemes.find((t) => t.id === id);
    if (seed) palette = { ...seed.palette };
  }

  /** The color well mirrors the hex field only when the value IS a plain hex
   *  color — a color-mix()/rgb() string keeps the text input authoritative. */
  function hexOf(value: string | undefined): string {
    return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"; // conformance-allowlisted: the color well's neutral fallback, not a themed color
  }

  function save() {
    error = "";
    const label = name.trim();
    if (!label) {
      error = "Give the theme a name.";
      return;
    }
    const id = editing ? editing.id : uniqueThemeId(label, $allThemes.map((t) => t.id));
    const candidate = { id, label, palette: palette as unknown as ThemePalette };
    if (!isTheme(candidate)) {
      error = "Every color needs a value (and “{ } ;” aren’t allowed).";
      return;
    }
    if (editing) updateCustomTheme(candidate);
    else addCustomTheme(candidate);
    setTheme(id);
    onOpenChange(false);
  }
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit theme" : "New theme"}</Dialog.Title>
      <Dialog.Description>
        {editing
          ? "Adjust the palette — saving applies it live."
          : "Start from an existing palette and make it yours."}
      </Dialog.Description>
    </Dialog.Header>

    <div class="theme-editor">
      <div class="editor-row">
        <span class="editor-label">Name</span>
        <Input
          bind:value={name}
          placeholder="My theme"
          class="h-8 w-52"
          aria-label="Theme name"
        />
      </div>

      {#if !editing}
        <div class="editor-row">
          <span class="editor-label">Start from</span>
          <Select.Root type="single" value={baseId} onValueChange={(v) => v && pickBase(v)}>
            <Select.Trigger class="h-8 w-52" aria-label="Start from theme">{baseLabel}</Select.Trigger>
            <Select.Content align="end">
              {#each $allThemes as t (t.id)}
                <Select.Item value={t.id} label={t.label}>{t.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {/if}

      <!-- Live preview: the working palette rendered as it will look. Inline
           styles by necessity — the values are dynamic user state. -->
      <div
        class="editor-preview"
        style="background: {palette.bg}; border-color: {palette.border};"
      >
        <span style="color: {palette.text};">text</span>
        <span style="color: {palette.textMuted};">muted</span>
        <span
          class="preview-chip"
          style="background: {palette.accent}; color: {palette.onAccent};">accent</span
        >
        {#each ["danger", "success", "info", "warning", "special"] as key (key)}
          <span class="preview-dot" style="background: {palette[key]};"></span>
        {/each}
      </div>

      <div class="editor-grid">
        {#each COLOR_KEYS as { key, label } (key)}
          <div class="editor-row">
            <span class="editor-label">{label}</span>
            <div class="editor-color">
              <input
                type="color"
                value={hexOf(palette[key])}
                oninput={(e) => (palette[key] = e.currentTarget.value)}
                aria-label="{label} color"
              />
              <Input
                bind:value={palette[key]}
                class="h-7 w-28 font-mono text-xs"
                aria-label="{label} value"
              />
            </div>
          </div>
        {/each}
        {#each TEXT_KEYS as { key, label, hint } (key)}
          <div class="editor-row editor-row-wide">
            <span class="editor-label" title={hint}>{label}</span>
            <Input
              bind:value={palette[key]}
              class="h-7 flex-1 font-mono text-xs"
              aria-label="{label} value"
              placeholder={hint}
            />
          </div>
        {/each}
      </div>

      {#if error}
        <p class="error-text">{error}</p>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="secondary" onclick={() => onOpenChange(false)}>Cancel</Button>
      <Button onclick={save}>{editing ? "Save" : "Create & apply"}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Editor layout is one-component structural CSS (split-by-reach). */
  .theme-editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: min(56vh, 560px);
    overflow-y: auto;
    padding-right: 2px;
  }
  .editor-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 16px;
  }
  .editor-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  .editor-row-wide {
    grid-column: 1 / -1;
  }
  .editor-label {
    font-size: var(--text-xs);
    color: var(--app-dim);
    white-space: nowrap;
  }
  .editor-color {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* The native color well, sized to sit beside the hex field. */
  .editor-color input[type="color"] {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--app-border);
    border-radius: var(--radius-xs);
    background: none;
  }
  .editor-preview {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
  }
  .preview-chip {
    padding: 2px 8px;
    border-radius: var(--radius-2xs);
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .preview-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
</style>
