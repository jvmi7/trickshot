<script lang="ts">
  // Store-free primitive: renders ANSI-SGR-styled text as plain <span> text
  // nodes carrying theme-token classes (parseAnsi in ansi.ts; the `.ansi-*`
  // rules live in app.css). Zero {@html} — the CSP/escaping posture is
  // untouched. The parent owns whitespace handling (render inside a
  // `white-space: pre-wrap` container like `.cl-pre` / `.run-log`).
  import { parseAnsi } from "../ansi";

  let { text }: { text: string } = $props();

  const spans = $derived(parseAnsi(text));
</script>

{#each spans as s}<span class={s.classes || undefined}>{s.text}</span>{/each}
