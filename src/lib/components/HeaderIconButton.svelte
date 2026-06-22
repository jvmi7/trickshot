<script lang="ts">
  // Shared chrome button for the floating titlebar icons (sidebar toggle +
  // settings gear) so they feel identical: same size, padding, dim/hover colors,
  // and a uniform icon size enforced in CSS regardless of the svg passed in.
  // Hand-built (not shadcn Button) because these are titlebar chrome —
  // transparent, dimmed, absolutely positioned over the overlay titlebar — not
  // content buttons. Spreads rest props so it can serve as a bits-ui
  // Dialog.Trigger `child` (the trigger's props land on this button).
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

<button type="button" class={cn("header-icon-btn", `header-icon-btn--${side}`, className)} {...rest}>
  {@render children()}
</button>
