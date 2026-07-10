<script lang="ts">
  // Renders potentially-huge text (tool inputs, tool results) without dumping
  // the whole blob into the DOM. Long content truncates to `max` chars with a
  // shadcn Collapsible trigger to reveal the rest.
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { buttonVariants } from "$lib/components/ui/button";

  let { text, max = 2000 }: { text: string; max?: number } = $props();

  let open = $state(false);
  const truncated = $derived(text.length > max);
</script>

{#if !truncated}
  <pre class="cl-pre">{text}</pre>
{:else}
  <Collapsible.Root bind:open>
    <pre class="cl-pre">{open ? text : text.slice(0, max) + "…"}</pre>
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
