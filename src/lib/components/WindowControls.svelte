<script lang="ts">
  // Custom macOS traffic lights: the window is UNDECORATED (transparent, the
  // .layout shell draws a custom-radius window), so the native controls are
  // gone — these replace them in the same footprint. Also maintains
  // html[data-fullscreen] (squares the shell's corners edge-to-edge) from the
  // window's resize events. Feature component (api wiring).
  import { onMount } from "svelte";
  import * as api from "../api";
  import Minus from "@lucide/svelte/icons/minus";
  import UnfoldHorizontal from "@lucide/svelte/icons/unfold-horizontal";
  import X from "@lucide/svelte/icons/x";

  async function syncFullscreen() {
    try {
      const fs = await api.windowIsFullscreen();
      if (fs) document.documentElement.dataset.fullscreen = "";
      else delete document.documentElement.dataset.fullscreen;
    } catch {
      /* window API unavailable (e.g. plain browser dev) — keep corners */
    }
  }
  onMount(() => {
    void syncFullscreen();
    let unlisten: (() => void) | undefined;
    api
      .onWindowResized(() => void syncFullscreen())
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  });
</script>

<div class="window-controls">
  <button type="button" class="wc-close" aria-label="Close window" onclick={() => void api.windowClose()}>
    <X />
  </button>
  <button
    type="button"
    class="wc-min"
    aria-label="Minimize window"
    onclick={() => void api.windowMinimize()}
  >
    <Minus />
  </button>
  <button
    type="button"
    class="wc-zoom"
    aria-label="Toggle fullscreen"
    onclick={() => void api.windowToggleFullscreen()}
  >
    <UnfoldHorizontal />
  </button>
</div>
