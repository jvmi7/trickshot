<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import * as api from "../api";
  import {
    availableModels,
    activeModel,
    selectedWorktree,
    sessionStatus,
    setWorktreeModel,
  } from "../stores";

  // setModel is a streaming-mode control request, so the session must be live.
  const status = $derived($selectedWorktree ? $sessionStatus[$selectedWorktree] : undefined);
  const alive = $derived(status === "running" || status === "working");
  const disabled = $derived(!$selectedWorktree || !alive || $availableModels.length === 0);

  const label = $derived(
    $availableModels.find((m) => m.value === $activeModel)?.displayName ?? $activeModel ?? "Model",
  );

  // Resilient catalog fetch (the ready-time broadcast can race the listener).
  const requested = new Set<string>();
  $effect(() => {
    const wt = $selectedWorktree;
    if (wt && alive && $availableModels.length === 0 && !requested.has(wt)) {
      requested.add(wt);
      api.requestModels(wt);
    }
  });

  function choose(value: string | undefined) {
    const wt = $selectedWorktree;
    if (!wt || !value || value === $activeModel) return;
    setWorktreeModel(wt, value);
    api.setModel(wt, value);
  }

  // Comparison axes — all framed so "more pips = better for you", letting users
  // read each model's tradeoff shape at a glance. Ratings (1–4) are inferred from
  // the model tier (haiku/sonnet/opus) + a 1M-context flag.
  const CATEGORIES = [
    { key: "reasoning", label: "Reasoning" },
    { key: "speed", label: "Speed" },
    { key: "value", label: "Value" },
    { key: "context", label: "Context" },
  ] as const;

  type Rating = Record<(typeof CATEGORIES)[number]["key"], number>;
  function rate(value: string, displayName: string): Rating {
    const s = `${value} ${displayName}`.toLowerCase();
    const context = /1m|\[1m\]/.test(s) ? 4 : 2;
    if (s.includes("haiku")) return { reasoning: 2, speed: 4, value: 4, context };
    if (s.includes("opus")) return { reasoning: 4, speed: 2, value: 1, context };
    return { reasoning: 3, speed: 3, value: 3, context }; // sonnet / default / unknown
  }

  const COLS = "grid-cols-[minmax(0,1fr)_repeat(4,3rem)]";
</script>

<Select.Root type="single" value={$activeModel ?? ""} onValueChange={choose} {disabled}>
  <Select.Trigger
    size="sm"
    class="text-muted-foreground h-9 gap-1 border-0 bg-transparent shadow-none focus-visible:ring-0 data-[size=sm]:h-9 dark:bg-transparent dark:hover:bg-input/40"
    aria-label="Model for this chat"
  >
    {label}
  </Select.Trigger>
  <Select.Content class="min-w-[360px]">
    <!-- Column header (category names), aligned to the item grid below. -->
    <div
      class="text-muted-foreground grid {COLS} items-center gap-x-2 pb-1.5 pl-1.5 pr-8 text-[9px] font-medium uppercase tracking-tight"
    >
      <span>Model</span>
      {#each CATEGORIES as c (c.key)}
        <span class="text-center">{c.label}</span>
      {/each}
    </div>
    {#each $availableModels as m (m.value)}
      {@const r = rate(m.value, m.displayName)}
      <Select.Item value={m.value} label={m.displayName}>
        <div class="grid w-full {COLS} items-center gap-x-2">
          <span class="truncate">{m.displayName}</span>
          {#each CATEGORIES as c (c.key)}
            <span class="flex justify-center gap-0.5">
              {#each Array(4) as _, i}
                <span
                  class="size-1.5 rounded-full {i < r[c.key] ? 'bg-primary' : 'bg-muted-foreground/25'}"
                ></span>
              {/each}
            </span>
          {/each}
        </div>
      </Select.Item>
    {/each}
  </Select.Content>
</Select.Root>
