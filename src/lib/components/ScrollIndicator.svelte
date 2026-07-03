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
