<script lang="ts">
  // Compact, merged rendering of ONE tool invocation. A tool_call and its
  // tool_result share an `id` (shared/protocol.ts); we look the result up by id
  // (toolResultsById) so the call collapses to a single dim line — verb + target
  // + status — that dominates far less than the assistant's prose. Clicking
  // expands the full input args and result. ALWAYS collapsed by default (errors
  // included — they show a ✗ marker so you know to expand, but don't auto-open).
  import type { AgentMessage } from "../types";
  import { toolLabel, toolDetail } from "../agentMessage";
  import { toolResultsById } from "../stores";
  import Collapsible from "./Collapsible.svelte";
  import * as Disclosure from "$lib/components/ui/collapsible";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";

  let { m }: { m: Extract<AgentMessage, { type: "tool_call" }> } = $props();

  const label = $derived(toolLabel(m.name));
  const detail = $derived(toolDetail(m.name, m.input));
  const result = $derived($toolResultsById[m.id]);
  const pending = $derived(result === undefined); // result not back yet
  const isError = $derived(result?.isError ?? false);
  const resultLines = $derived(result ? result.content.split("\n").length : 0);
  const inputJson = $derived(JSON.stringify(m.input, null, 2));

  let open = $state(false);
</script>

<div class="tool-row" class:error={isError}>
  <Disclosure.Root bind:open>
    <Disclosure.Trigger class="tool-row-head">
      <ChevronRight class="tool-chevron size-3.5" />
      <span class="tool-label">{label}</span>
      {#if detail}<span class="tool-detail">{detail}</span>{/if}
      <span class="tool-status">
        {#if pending}
          <i class="tool-pending"></i>
        {:else if isError}
          <X class="size-3.5" />
        {:else}
          <Check class="size-3.5" />
        {/if}
      </span>
    </Disclosure.Trigger>
    <Disclosure.Content class="tool-row-body">
      <div class="tool-block">
        <div class="tool-block-label">input</div>
        <Collapsible text={inputJson} />
      </div>
      {#if result}
        <div class="tool-block">
          <div class="tool-block-label">result · {resultLines} line{resultLines === 1 ? "" : "s"}</div>
          <Collapsible text={result.content} />
        </div>
      {/if}
    </Disclosure.Content>
  </Disclosure.Root>
</div>
