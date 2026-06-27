<script lang="ts">
  // The floating titlebar icons (sidebar toggle + settings gear): an IconButton
  // positioned absolutely over the overlay titlebar (left/right via `side`). All
  // the shared look (size, dim/hover, icon sizing) lives in IconButton; this only
  // adds the positioning. Rest props pass through (e.g. a Dialog/Tooltip trigger).
  import IconButton from "./IconButton.svelte";
  import { cn } from "$lib/utils";
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  let {
    side,
    class: className,
    children,
    ...rest
  }: HTMLButtonAttributes & { side: "left" | "right"; children: Snippet } = $props();
</script>

<IconButton class={cn(`header-icon-btn header-icon-btn--${side}`, className)} {...rest}>
  {@render children()}
</IconButton>
