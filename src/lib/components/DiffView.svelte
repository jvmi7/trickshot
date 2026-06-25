<script lang="ts">
  // Renders a unified diff (raw `git diff` text) with per-line coloring. App-
  // specific rendering with no shadcn counterpart, so hand-built (per CLAUDE.md).
  // The DOM is bounded: very large diffs are capped with a "more lines hidden"
  // note rather than mounting tens of thousands of rows.
  let { diff }: { diff: string } = $props();

  const MAX_LINES = 2000;
  const lines = $derived(diff ? diff.split("\n") : []);
  const shown = $derived(lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines);
  const hidden = $derived(lines.length - shown.length);

  /** Classify a diff line for coloring. */
  function kind(line: string): string {
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+++") || line.startsWith("---")) return "meta";
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ")
    )
      return "meta";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "ctx";
  }
</script>

{#if lines.length === 0}
  <div class="diff-empty">No changes in this file.</div>
{:else}
  <div class="diff">
    {#each shown as line, i (i)}
      <div class="ln {kind(line)}">{line || " "}</div>
    {/each}
    {#if hidden > 0}
      <div class="ln meta">… {hidden} more line{hidden === 1 ? "" : "s"} hidden</div>
    {/if}
  </div>
{/if}

<style>
  .diff {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.5;
    overflow: auto;
    height: 100%;
  }
  .ln {
    display: block;
    white-space: pre;
    padding: 0 8px;
  }
  .add {
    background: color-mix(in oklch, var(--app-success, #2ea043) 16%, transparent);
    color: var(--app-success, #2ea043);
  }
  .del {
    background: color-mix(in oklch, var(--destructive) 16%, transparent);
    color: var(--destructive);
  }
  .hunk {
    color: var(--primary);
    background: color-mix(in oklch, var(--primary) 8%, transparent);
  }
  .meta {
    color: var(--app-dim);
  }
  .diff-empty {
    color: var(--app-dim);
    font-size: 12px;
    padding: 16px;
    text-align: center;
  }
</style>
