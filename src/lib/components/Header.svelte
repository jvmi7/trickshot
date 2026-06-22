<script lang="ts"></script>

<!--
  Top bar for the content column (custom titlebar region, macOS Overlay style).
  The whole bar is a drag region so the window can be moved by dragging empty
  space; interactive controls (buttons/selects) aren't drag regions, so they keep
  working. The sidebar toggle floats separately (App.svelte) so it survives the
  sidebar collapsing; this bar just holds right-aligned `actions`.
-->
<header class="app-header" data-tauri-drag-region>
  <slot name="left" />
  <span class="spacer" data-tauri-drag-region></span>
  <slot name="actions" />
</header>
