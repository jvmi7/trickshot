<!-- DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
     (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
     "Deprecated GUI surface" before extending. -->
<script lang="ts">
  // Store-free primitive: renders a detectTable() result (tabular.ts) as a real
  // table. The `.text-table` scope shares the markdown table look via app.css's
  // `:where(.markdown, .text-table)` rules (the `:where(.markdown, .diff)` hljs
  // precedent) — ONE home for the table styling, no forked copy here.
  import type { DetectedTable } from "../tabular";

  let { table }: { table: DetectedTable } = $props();
</script>

<div class="text-table">
  <table>
    <thead>
      <tr>
        {#each table.header as h}<th>{h}</th>{/each}
      </tr>
    </thead>
    <tbody>
      {#each table.rows as row}
        <tr>
          {#each row as cell}<td>{cell}</td>{/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  /* Sizing only — the table chrome itself lives in app.css (shared with
     .markdown). Tool-result context reads at the secondary body size. */
  .text-table {
    font-size: var(--text-sm);
  }
</style>