<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import { font, FONTS } from "../stores";

  const label = $derived(FONTS.find((f) => f.id === $font)?.label ?? "Font");

  function choose(value: string | undefined) {
    if (value) font.set(value);
  }
</script>

<Select.Root type="single" value={$font} onValueChange={choose}>
  <Select.Trigger
    size="sm"
    class="text-muted-foreground gap-1.5 border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent dark:hover:bg-input/40"
    aria-label="UI font"
  >
    <i class="lni lni-text-format text-base leading-none"></i>
    {label}
  </Select.Trigger>
  <Select.Content align="end">
    {#each FONTS as f (f.id)}
      <Select.Item value={f.id} label={f.label}>{f.label}</Select.Item>
    {/each}
  </Select.Content>
</Select.Root>
