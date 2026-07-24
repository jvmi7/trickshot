<script lang="ts">
  // The status FOOTER: a slim band under the terminal card (the header's
  // quiet sibling). Home of the subscription usage chip and small ambient
  // items — add here, not to the header, when something belongs "below the
  // work". Feature component (stores wiring).
  import { repos, toggleCommandPalette } from "../stores";
  import UsageIndicator from "./UsageIndicator.svelte";
  import Command from "@lucide/svelte/icons/command";
</script>

{#if $repos.length > 0}
  <footer class="app-footer">
    <button type="button" class="footer-hint" onclick={toggleCommandPalette}>
      <Command /> P
      <span class="footer-hint-label">shortcuts</span>
    </button>
    <span class="footer-spacer"></span>
    <UsageIndicator />
  </footer>
{/if}
