<script lang="ts">
  // The trickshot "eyes" brand mark (from the app's logo). A deliberate
  // exception to the Lucide-only icon rule: this is the app's own mark, not a
  // generic glyph. Prop-driven primitive — fills with currentColor so it
  // takes the same color treatment as any icon beside it.
  let { class: className }: { class?: string } = $props();
</script>

<svg class={className} viewBox="0 0 44 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path
    d="M5.36029 14.5693C10.4862 17.5145 17.0406 15.7667 20 10.6655L1.4376 0C-1.52182 5.10122 0.234427 11.6241 5.36029 14.5693Z"
    fill="currentColor"
  />
  <path
    d="M38.6397 14.5693C33.5138 17.5145 26.9594 15.7667 24 10.6655L42.5624 0C45.5218 5.10122 43.7656 11.6241 38.6397 14.5693Z"
    fill="currentColor"
  />
</svg>
