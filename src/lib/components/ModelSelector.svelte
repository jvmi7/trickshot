<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import * as api from "../api";
  import {
    availableModels,
    activeModel,
    selectedWorktree,
    sessionStatus,
    setWorktreeModel,
    requestOnce,
  } from "../stores";

  // setModel is a streaming-mode control request, so the session must be live.
  const status = $derived($selectedWorktree ? $sessionStatus[$selectedWorktree] : undefined);
  const alive = $derived(status === "ready" || status === "busy");
  const disabled = $derived(!$selectedWorktree || !alive || $availableModels.length === 0);

  const label = $derived(
    $availableModels.find((m) => m.value === $activeModel)?.displayName ?? $activeModel ?? "Model",
  );

  // Resilient catalog fetch (the ready-time broadcast can race the listener).
  $effect(() => {
    const wt = $selectedWorktree;
    if (wt && alive && $availableModels.length === 0) requestOnce(wt, "models", api.requestModels);
  });

  function choose(value: string | undefined) {
    const wt = $selectedWorktree;
    if (!wt || !value || value === $activeModel) return;
    setWorktreeModel(wt, value);
    api.setModel(wt, value);
  }

  // Comparison axes are PROVIDER-SUPPLIED (ModelInfo.meta) — the UI no longer
  // infers tiers from the model name. Header labels come from the first model
  // that ships meta; the column grid sizes to that count.
  const metaLabels = $derived($availableModels.find((m) => m.meta?.length)?.meta?.map((r) => r.label) ?? []);
  const cols = $derived(`minmax(0,1fr) repeat(${metaLabels.length}, 3rem)`);
</script>

<Select.Root type="single" value={$activeModel ?? ""} onValueChange={choose} {disabled}>
  <Select.Trigger
    size="sm"
    class="text-muted-foreground h-9 gap-1 border-0 bg-transparent shadow-none focus-visible:ring-0 data-[size=sm]:h-9 dark:bg-transparent dark:hover:bg-input/40"
    aria-label="Model for this chat"
  >
    {label}
  </Select.Trigger>
  <Select.Content class={metaLabels.length ? "min-w-[360px]" : undefined}>
    {#if metaLabels.length}
      <!-- Column header (provider's category names), aligned to the item grid. -->
      <div
        class="text-muted-foreground grid items-center gap-x-2 pb-1.5 pl-1.5 pr-8 text-[9px] font-medium uppercase tracking-tight"
        style="grid-template-columns: {cols}"
      >
        <span>Model</span>
        {#each metaLabels as l (l)}
          <span class="text-center">{l}</span>
        {/each}
      </div>
    {/if}
    {#each $availableModels as m (m.value)}
      <Select.Item value={m.value} label={m.displayName}>
        {#if m.meta?.length}
          <div class="grid w-full items-center gap-x-2" style="grid-template-columns: {cols}">
            <span class="truncate">{m.displayName}</span>
            {#each m.meta as r (r.label)}
              <span class="flex justify-center gap-0.5">
                {#each Array(r.max ?? 4) as _, i}
                  <span
                    class="size-1.5 rounded-full {i < r.score ? 'bg-primary' : 'bg-muted-foreground/25'}"
                  ></span>
                {/each}
              </span>
            {/each}
          </div>
        {:else}
          <span class="truncate">{m.displayName}</span>
        {/if}
      </Select.Item>
    {/each}
  </Select.Content>
</Select.Root>
