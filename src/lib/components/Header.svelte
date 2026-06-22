<script lang="ts"></script>

<!--
  Global header / custom titlebar (macOS Overlay style): the traffic lights
  overlay its left. The whole bar is a drag region so the window can be moved by
  dragging empty space; interactive controls (buttons/selects) aren't drag
  regions, so they keep working. Slots: `left` and right-aligned `actions`.
-->
<header class="app-header" data-tauri-drag-region>
  <slot name="left" />
  <span class="spacer" data-tauri-drag-region></span>
  <slot name="actions" />
</header>
