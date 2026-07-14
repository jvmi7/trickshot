<!-- DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
     (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
     "Deprecated GUI surface" before extending. -->
<script lang="ts">
  import { scrollCursor } from "../stores";

  // Visible while scrolling, lingering briefly after so it fades out gracefully.
  let visible = $state(false);
  let hide: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const { active, max } = $scrollCursor;
    if (max <= 0) {
      visible = false;
      return;
    }
    if (active) {
      if (hide) {
        clearTimeout(hide);
        hide = null;
      }
      visible = true;
    } else if (visible) {
      if (hide) clearTimeout(hide);
      hide = setTimeout(() => (visible = false), 900);
    }
    return () => {
      if (hide) {
        clearTimeout(hide);
        hide = null;
      }
    };
  });
</script>

<div class="scroll-indic" class:visible aria-hidden="true">
  <div class="scroll-indic-fill" style="height: {$scrollCursor.progress * 100}%"></div>
</div>

<style>
  /* Scroll position indicator (top-right): animates in on scroll, fill tracks the
     cursor frame-accurately, fades out when idle. */
  .scroll-indic {
    position: absolute;
    top: 14px;
    right: 12px;
    width: 4px;
    height: 120px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-dim) 30%, transparent); /* track = dim muted */
    /* Hidden = slid fully off the right edge (clipped by the viewport's overflow).
       Pure slide — no opacity or scale — on a smooth ease-out curve. */
    transform: translateX(calc(100% + 12px));
    transition: transform var(--app-duration-slow) var(--ease-out-soft);
    pointer-events: none;
    overflow: hidden;
    z-index: var(--app-z-indicator);
  }
  .scroll-indic.visible {
    transform: translateX(0);
  }
  .scroll-indic-fill {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    background: color-mix(in srgb, var(--app-text) 60%, transparent); /* fill = dimmed text */
    border-radius: 999px;
  }
</style>