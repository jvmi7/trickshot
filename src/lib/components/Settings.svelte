<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import HeaderIconButton from "./HeaderIconButton.svelte";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import { font, FONTS, theme, THEMES } from "../stores";

  let open = $state(false);

  // Trigger label = the currently-selected option's display label.
  const themeLabel = $derived(THEMES.find((t) => t.id === $theme)?.label ?? "Theme");
  const fontLabel = $derived(FONTS.find((f) => f.id === $font)?.label ?? "Font");
</script>

<!-- Floating gear, mirrored against the sidebar toggle on the top-left. The
     tooltip wraps the shared button; the dialog opens via `open` so we don't
     stack two triggers (tooltip + dialog) on the same element. -->
<Tooltip.Root>
  <Tooltip.Trigger>
    {#snippet child({ props })}
      <HeaderIconButton side="right" {...props} onclick={() => (open = true)} aria-label="Settings">
        <SettingsIcon />
      </HeaderIconButton>
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Content>Settings</Tooltip.Content>
</Tooltip.Root>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[420px]">
    <Dialog.Header>
      <Dialog.Title>Settings</Dialog.Title>
      <Dialog.Description>Customize the look and feel.</Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-4 py-1">
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
    </div>
  </Dialog.Content>
</Dialog.Root>
