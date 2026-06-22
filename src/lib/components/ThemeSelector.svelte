<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import { theme, THEMES } from "../stores";

  const label = $derived(THEMES.find((t) => t.id === $theme)?.label ?? "Theme");

  function choose(value: string | undefined) {
    if (value) theme.set(value);
  }
</script>

<Select.Root type="single" value={$theme} onValueChange={choose}>
  <Select.Trigger
    size="sm"
    class="text-muted-foreground gap-1.5 border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent dark:hover:bg-input/40"
    aria-label="Color theme"
  >
    <i class="lni lni-brush-2 text-base leading-none"></i>
    {label}
  </Select.Trigger>
  <Select.Content align="end">
    {#each THEMES as t (t.id)}
      <Select.Item value={t.id} label={t.label}>{t.label}</Select.Item>
    {/each}
  </Select.Content>
</Select.Root>
