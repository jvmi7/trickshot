<!-- DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
     (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
     "Deprecated GUI surface" before extending. -->
<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import { ghostSelectTrigger } from "$lib/utils";
  import * as api from "../api";
  import {
    availableModels,
    activeModel,
    activeSessionAlive,
    selectedWorktree,
    setWorktreeModel,
    requestOnce,
  } from "../stores";

  // setModel is a streaming-mode control request, so the session must be live.
  const disabled = $derived(!$selectedWorktree || !$activeSessionAlive || $availableModels.length === 0);

  const label = $derived(
    $availableModels.find((m) => m.value === $activeModel)?.displayName ?? $activeModel ?? "Model",
  );

  // Resilient catalog fetch (the ready-time broadcast can race the listener). The
  // `seen` Set is instance-scoped so a remount/session-restart can re-request.
  const requested = new Set<string>();
  $effect(() => {
    const wt = $selectedWorktree;
    if (wt && $activeSessionAlive && $availableModels.length === 0)
      requestOnce(requested, wt, "models", api.requestModels);
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
  <Select.Trigger size="sm" class={ghostSelectTrigger} aria-label="Model for this chat">
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