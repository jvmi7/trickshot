<script lang="ts">
  // A run of consecutive tool calls (see renderedGroups in stores). 2+ calls
  // collapse into ONE line ("N tool calls", collapsed by default) that expands to
  // the individual ToolActivity rows — so a turn that fires dozens of tools no
  // longer spams the transcript. A lone call renders inline (no group wrapper).
  // A ✗ on the header flags that some call in the run errored (since it's all
  // collapsed by default, this is how you know to drill in).
  import type { TranscriptMessage } from "../types";
  import { toolResultsById } from "../stores";
  import ToolActivity from "./ToolActivity.svelte";
  import * as Disclosure from "$lib/components/ui/collapsible";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import X from "@lucide/svelte/icons/x";

  let { tools }: { tools: Extract<TranscriptMessage, { type: "tool_call" }>[] } = $props();

  const anyError = $derived(tools.some((t) => $toolResultsById[t.id]?.isError));
  let open = $state(false);
</script>

<div class="msg assistant">
  <div class="body">
    {#if tools.length > 1}
      <div class="tool-group" class:error={anyError}>
        <Disclosure.Root bind:open>
          <Disclosure.Trigger class="tool-row-head">
            <ChevronRight class="tool-chevron size-3.5" />
            <span class="tool-label">{tools.length} tool calls</span>
            <span class="tool-status">{#if anyError}<X class="size-3.5" />{/if}</span>
          </Disclosure.Trigger>
          <Disclosure.Content class="tool-group-body">
            {#each tools as m (m.__key)}
              <ToolActivity {m} />
            {/each}
          </Disclosure.Content>
        </Disclosure.Root>
      </div>
    {:else}
      {#each tools as m (m.__key)}
        <ToolActivity {m} />
      {/each}
    {/if}
  </div>
</div>
