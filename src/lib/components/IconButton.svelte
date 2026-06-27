<script lang="ts">
  // Shared chrome icon button — a 24px square that's dim by default and fades to a
  // raised-surface background + brighter icon on hover, with its icon forced to a
  // uniform size (see `.icon-chrome-btn` in app.css; the svg sizing rule must stay
  // global so it reaches the slotted icon). Used by the titlebar buttons
  // (HeaderIconButton) and the sidebar add-repo/add-worktree buttons.
  //
  // Spreads rest props onto the <button> so it can serve as a bits-ui
  // Tooltip/Dialog Trigger `child` (the trigger's props land here). Pass extra
  // classes (positioning, hover-reveal) via `class`.
  import { cn } from "$lib/utils";
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  let {
    class: className,
    children,
    ...rest
  }: HTMLButtonAttributes & { children: Snippet } = $props();
</script>

<button type="button" class={cn("icon-chrome-btn", className)} {...rest}>
  {@render children()}
</button>
