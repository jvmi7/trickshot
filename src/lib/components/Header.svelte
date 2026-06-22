<script lang="ts">
  import { sidebarOpen } from "../stores";
  import { Button } from "$lib/components/ui/button";

  /** Header title. For richer content, use the `title` slot instead. */
  export let title = "trickshot";

  function toggle() {
    sidebarOpen.update((v) => !v);
  }
</script>

<!--
  Global application header. Customization points:
    • `title` prop, or the `title` slot for full control of the center region.
    • `left` slot    — content immediately after the sidebar toggle.
    • `actions` slot — right-aligned controls (buttons, status, menus, …).
-->
<header class="app-header">
  <Button
    variant="ghost"
    size="icon"
    onclick={toggle}
    title={$sidebarOpen ? "Hide sidebar" : "Show sidebar"}
    aria-label="Toggle sidebar"
  >☰</Button>

  <slot name="left" />

  <slot name="title"><span class="title">{title}</span></slot>

  <span class="spacer"></span>

  <slot name="actions" />
</header>
