<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import HeaderIconButton from "./HeaderIconButton.svelte";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import * as api from "../api";
  import { font, FONTS, theme, THEMES } from "../stores";

  let open = $state(false);

  // Trigger label = the currently-selected option's display label.
  const themeLabel = $derived(THEMES.find((t) => t.id === $theme)?.label ?? "Theme");
  const fontLabel = $derived(FONTS.find((f) => f.id === $font)?.label ?? "Font");

  // ---- GLM (Z.ai) credentials. The key lives in the OS keychain (Rust side) and
  // is never echoed back here; we only learn whether one is stored. ----
  let zaiKey = $state(""); // write-only input; blank means "leave the stored key"
  let zaiBaseUrl = $state("");
  let zaiKeyPresent = $state(false);
  let zaiBusy = $state(false);
  let zaiMsg = $state("");

  // (Re)load on each open so the form reflects stored state without echoing the key.
  $effect(() => {
    if (!open) return;
    zaiMsg = "";
    zaiKey = "";
    api
      .getZaiSettings()
      .then((s) => {
        zaiBaseUrl = s.base_url;
        zaiKeyPresent = s.key_present;
      })
      .catch(() => {});
  });

  async function saveZai() {
    zaiBusy = true;
    zaiMsg = "";
    try {
      // Only send the key when the user typed one, so saving the base URL doesn't
      // wipe the stored key (which the field never shows).
      await api.setZaiSettings(zaiKey.trim() || undefined, zaiBaseUrl.trim());
      const s = await api.getZaiSettings();
      zaiBaseUrl = s.base_url;
      zaiKeyPresent = s.key_present;
      zaiKey = "";
      zaiMsg = "Saved";
    } catch (e) {
      zaiMsg = String(e);
    } finally {
      zaiBusy = false;
    }
  }

  async function removeZaiKey() {
    zaiBusy = true;
    zaiMsg = "";
    try {
      await api.setZaiSettings("", undefined); // empty string clears the stored key
      zaiKeyPresent = false;
      zaiKey = "";
      zaiMsg = "Key removed";
    } catch (e) {
      zaiMsg = String(e);
    } finally {
      zaiBusy = false;
    }
  }
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

      <!-- GLM (Z.ai): the key needed for the GLM model option. Stored in the OS
           keychain via Rust; never persisted to localStorage or shown back here. -->
      <div class="mt-1 flex flex-col gap-3 border-t pt-4">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">GLM (Z.ai)</span>
          {#if zaiKeyPresent}
            <span class="text-xs text-muted-foreground">key saved ✓</span>
          {/if}
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">API key</span>
          <Input
            type="password"
            autocomplete="off"
            placeholder={zaiKeyPresent ? "•••••••• (stored)" : "paste your Z.ai API key"}
            bind:value={zaiKey}
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Base URL</span>
          <Input autocomplete="off" placeholder="https://api.z.ai/api/anthropic" bind:value={zaiBaseUrl} />
        </div>

        <div class="flex items-center justify-between gap-2">
          <span
            class="text-xs {zaiMsg === 'Saved' || zaiMsg === 'Key removed'
              ? 'text-muted-foreground'
              : 'text-destructive'}">{zaiMsg}</span
          >
          <div class="flex gap-2">
            {#if zaiKeyPresent}
              <Button variant="ghost" size="sm" onclick={removeZaiKey} disabled={zaiBusy}>
                Remove key
              </Button>
            {/if}
            <Button size="sm" onclick={saveZai} disabled={zaiBusy}>Save</Button>
          </div>
        </div>
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
