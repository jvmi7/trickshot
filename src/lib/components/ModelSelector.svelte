<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import * as api from "../api";
  import type { ModelInfo } from "../types";
  import {
    availableModels,
    activeModel,
    activeProvider,
    selectedWorktree,
    sessionStatus,
    setStatus,
    setWorktreeModel,
    setWorktreeProvider,
    forgetWorktreeSession,
  } from "../stores";

  // A dropdown entry tagged with the provider it belongs to. The live catalog is
  // the running provider's; cross-provider entries are static stubs (below).
  type CatalogEntry = ModelInfo & { provider: string };

  // Headline model per provider, used as the stub for whichever provider is NOT
  // currently running so you can switch to it. Pips mirror each provider's own
  // catalog so the comparison grid stays aligned.
  const HEADLINE: Record<string, CatalogEntry> = {
    claude: {
      provider: "claude",
      value: "claude-opus-4-8",
      displayName: "Opus 4.8",
      meta: [
        { label: "Reasoning", score: 4 },
        { label: "Speed", score: 2 },
        { label: "Value", score: 1 },
        { label: "Context", score: 2 },
      ],
    },
    glm: {
      provider: "glm",
      value: "glm-5.2",
      displayName: "GLM-5.2",
      meta: [
        { label: "Reasoning", score: 4 },
        { label: "Speed", score: 3 },
        { label: "Value", score: 4 },
        { label: "Context", score: 4 },
      ],
    },
  };

  // setModel/restart are control requests, so the session must be live.
  const status = $derived($selectedWorktree ? $sessionStatus[$selectedWorktree] : undefined);
  const alive = $derived(status === "ready" || status === "busy");
  const busy = $derived(status === "busy");
  const disabled = $derived(!$selectedWorktree || !alive || $availableModels.length === 0);

  // The merged catalog: the running provider's live models, plus a stub for each
  // other provider (a switch restarts the sidecar — see `choose`).
  const merged = $derived.by<CatalogEntry[]>(() => {
    const cur = $activeProvider;
    const live: CatalogEntry[] = $availableModels.map((m) => ({ ...m, provider: cur }));
    const others = Object.values(HEADLINE).filter((h) => h.provider !== cur);
    return [...live, ...others];
  });

  const label = $derived(
    merged.find((m) => m.value === $activeModel)?.displayName ?? $activeModel ?? "Model",
  );

  // Local error (command-rejection path): e.g. picking GLM with no key stored.
  let switchError = $state("");

  // Resilient catalog fetch (the ready-time broadcast can race the listener).
  const requested = new Set<string>();
  $effect(() => {
    const wt = $selectedWorktree;
    if (wt && alive && $availableModels.length === 0 && !requested.has(wt)) {
      requested.add(wt);
      api.requestModels(wt);
    }
  });

  async function choose(entry: CatalogEntry) {
    const wt = $selectedWorktree;
    if (!wt) return;
    switchError = "";

    // Same provider: an in-session model switch (no restart).
    if (entry.provider === $activeProvider) {
      if (entry.value === $activeModel) return;
      setWorktreeModel(wt, entry.value);
      api.setModel(wt, entry.value);
      return;
    }

    // Cross-provider: GLM needs a stored key — preflight so we don't kill the
    // current session only to fail spawning the new one.
    if (entry.provider === "glm") {
      const { key_present } = await api.getZaiSettings();
      if (!key_present) {
        switchError = "Add your Z.ai API key in Settings to use GLM.";
        return;
      }
    }

    // Switch the provider (fixed for a sidecar's life) → restart. The agent
    // context is provider-specific, so start fresh; the transcript stays visible.
    setWorktreeProvider(wt, entry.provider);
    setWorktreeModel(wt, entry.value);
    forgetWorktreeSession(wt);
    setStatus(wt, "stopped"); // optimistic; the new session's `ready` flips it back
    try {
      await api.restartSession(wt, undefined, entry.provider);
    } catch (e) {
      switchError = String(e);
    }
  }

  function onChoose(value: string | undefined) {
    if (!value) return;
    const entry = merged.find((m) => m.value === value);
    if (entry) void choose(entry);
  }

  // Comparison axes are PROVIDER-SUPPLIED (ModelInfo.meta) — the UI doesn't infer
  // tiers. Header labels come from the first entry that ships meta; the grid sizes
  // to that count.
  const metaLabels = $derived(merged.find((m) => m.meta?.length)?.meta?.map((r) => r.label) ?? []);
  const cols = $derived(`minmax(0,1fr) repeat(${metaLabels.length}, 3rem)`);
</script>

<div class="relative">
  <Select.Root type="single" value={$activeModel ?? ""} onValueChange={onChoose} {disabled}>
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
      {#each merged as m (m.provider + ":" + m.value)}
        <Select.Item
          value={m.value}
          label={m.displayName}
          disabled={busy && m.provider !== $activeProvider}
        >
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

  {#if switchError}
    <span class="text-destructive absolute left-2 top-full mt-0.5 whitespace-nowrap text-xs">
      {switchError}
    </span>
  {/if}
</div>
