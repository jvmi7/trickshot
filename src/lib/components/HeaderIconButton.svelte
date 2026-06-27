<script lang="ts">
  // The floating titlebar icon button (the sidebar toggle): an IconButton
  // positioned absolutely over the overlay titlebar, just past the traffic
  // lights. All the shared look (size, dim/hover, icon sizing) lives in
  // IconButton; this only adds the fixed positioning. Rest props pass through
  // (e.g. a Dialog/Tooltip trigger).
  import IconButton from "./IconButton.svelte";
  import { cn } from "$lib/utils";
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  let {
    class: className,
    children,
    ...rest
  }: HTMLButtonAttributes & { children: Snippet } = $props();
</script>

<IconButton class={cn("header-icon-btn", className)} {...rest}>
  {@render children()}
</IconButton>
