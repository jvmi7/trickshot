<script lang="ts">
  // Renders a unified diff (raw `git diff` text) with per-line coloring. App-
  // specific rendering with no shadcn counterpart, so hand-built (per CLAUDE.md).
  // The DOM is bounded: very large diffs are capped with a "more lines hidden"
  // note rather than mounting tens of thousands of rows. Code rows (add/del/ctx)
  // are syntax-highlighted by file type via the shared highlight.js setup, with
  // the +/- prefix kept literal and the row's add/del background preserved.
  import { escapeHtml, highlightCode, langFromPath } from "$lib/highlight";

  let { diff, path }: { diff: string; path?: string | null } = $props();

  const MAX_LINES = 2000;
  const lines = $derived(diff ? diff.split("\n") : []);
  const shown = $derived(lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines);
  const hidden = $derived(lines.length - shown.length);
  // Highlighting is per-line (no cross-line context), the lightweight tradeoff:
  // a line inside a block comment may mis-color, but the DOM stays bounded and
  // there's no whole-file reconstruction. "" when the type is unknown → escaped
  // plain text, same as before.
  const lang = $derived(langFromPath(path));

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

  /** Render one diff line to safe HTML. Only the code rows are syntax-coloured,
   *  and only when the file type is known; the +/- prefix stays literal so it
   *  never gets swept into the highlighter. Everything routes through an escape
   *  (here or inside highlightCode), so {@html} is XSS-safe under the app CSP. */
  function render(line: string, k: string): string {
    const text = line || " ";
    if (lang && (k === "add" || k === "del" || k === "ctx")) {
      return escapeHtml(text.slice(0, 1)) + highlightCode(text.slice(1), lang);
    }
    return escapeHtml(text);
  }
</script>

{#if lines.length === 0}
  <div class="diff-empty">No changes in this file.</div>
{:else}
  <div class="diff">
    {#each shown as line, i (i)}
      {@const k = kind(line)}
      <div class="ln {k}">{@html render(line, k)}</div>
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
  /* Add/del rows carry only the background tint; token text color comes from the
     shared `.hljs-*` palette in app.css (which is layered, so an unlayered scoped
     `color` here would override it and flatten every token to one hue). Plain,
     untokenised text falls back to the inherited diff foreground. */
  .add {
    background: color-mix(in oklch, var(--base-success) 16%, transparent);
  }
  .del {
    background: color-mix(in oklch, var(--destructive) 16%, transparent);
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
