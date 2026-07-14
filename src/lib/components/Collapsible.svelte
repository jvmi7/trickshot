<!-- DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
     (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
     "Deprecated GUI surface" before extending. -->
<script lang="ts">
  // Renders potentially-huge text (tool inputs, tool results) without dumping
  // the whole blob into the DOM. Long content truncates to `max` chars with a
  // shadcn Collapsible trigger to reveal the rest. `ansi`: opt-in ANSI-SGR
  // styling for terminal-flavored text (tool results, logs) — truncation math
  // stays on the RAW string, and only the shown slice is parsed (parseAnsi
  // drops a truncated trailing escape silently), so plain text costs nothing.
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { buttonVariants } from "$lib/components/ui/button";
  import { hasAnsi } from "../ansi";
  import AnsiText from "./AnsiText.svelte";

  let { text, max = 2000, ansi = false }: { text: string; max?: number; ansi?: boolean } = $props();

  let open = $state(false);
  const truncated = $derived(text.length > max);
  const styled = $derived(ansi && hasAnsi(text));
</script>

{#snippet body(shown: string)}
  <pre class="cl-pre">{#if styled}<AnsiText text={shown} />{:else}{shown}{/if}</pre>
{/snippet}

{#if !truncated}
  {@render body(text)}
{:else}
  <Collapsible.Root bind:open>
    {@render body(open ? text : text.slice(0, max) + "…")}
    <Collapsible.Trigger class={buttonVariants({ variant: "ghost", size: "sm" })}>
      {open ? "Show less" : `Show ${text.length - max} more characters`}
    </Collapsible.Trigger>
  </Collapsible.Root>
{/if}

<style>
  .cl-pre {
    font-size: var(--text-xs);
    overflow-x: auto;
    margin: 0 0 6px;
    color: var(--app-dim);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>