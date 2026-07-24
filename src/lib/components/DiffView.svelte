<script lang="ts">
  // Renders a unified diff (raw `git diff` text) with per-line coloring. App-
  // specific rendering with no shadcn counterpart, so hand-built (per CLAUDE.md).
  // The DOM is bounded: very large diffs are capped with a "more lines hidden"
  // note rather than mounting tens of thousands of rows. Code rows (add/del/ctx)
  // are syntax-highlighted by file type via the shared highlight.js setup, with
  // the +/- prefix kept literal and the row's add/del background preserved.
  // Prop-driven primitive: the optional `onLineComment` callback (review
  // comments on a diff line) keeps the store/agent wiring in the parent.
  import { pairChanges, splitCommon, worthHighlighting } from "$lib/diffIntraline";
  import { escapeHtml, highlightCode, langFromPath } from "$lib/highlight";
  import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";

  let {
    diff,
    path,
    onLineComment,
    commentedLines,
  }: {
    diff: string;
    path?: string | null;
    /** When set, code rows grow a hover affordance; clicking it hands back the
     *  line text + its enclosing @@ hunk header for a review comment. */
    onLineComment?: (ctx: { line: string; hunk: string | null }) => void;
    /** Lines (exact text, marker included) with a queued review comment — their
     *  gutter glyph stays visible/accented so the review-in-progress shows. */
    commentedLines?: ReadonlySet<string>;
  } = $props();

  const MAX_LINES = 2000;
  const lines = $derived(diff ? diff.split("\n") : []);
  // Drop git's file-header metadata (diff --git, index, mode, ---/+++); keep the
  // code rows and the @@ hunk markers.
  const content = $derived(lines.filter((l) => kind(l) !== "meta"));
  const shown = $derived(content.length > MAX_LINES ? content.slice(0, MAX_LINES) : content);
  const hidden = $derived(content.length - shown.length);
  // The nearest preceding @@ header per shown row (comment context). One O(n)
  // pass, recomputed only when the diff changes.
  const hunkFor = $derived.by(() => {
    let current: string | null = null;
    return shown.map((l) => {
      if (kind(l) === "hunk") current = l;
      return current;
    });
  });
  // Old/new line numbers per shown row, derived from the @@ hunk headers in the
  // same one-pass style as hunkFor: ctx advances both counters, add only the new
  // side, del only the old side. null = no number on that side.
  const lineNos = $derived.by(() => {
    let o = 0;
    let n = 0;
    return shown.map((l): { o: number | null; n: number | null } => {
      const k = kind(l);
      if (k === "hunk") {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
        o = Number.parseInt(m?.[1] ?? "0", 10);
        n = Number.parseInt(m?.[2] ?? "0", 10);
        return { o: null, n: null };
      }
      if (k === "add") return { o: null, n: n++ };
      if (k === "del") return { o: o++, n: null };
      if (k === "ctx") return { o: o++, n: n++ };
      return { o: null, n: null };
    });
  });
  // Gutter width scales with the file: enough ch for the largest number shown.
  const noWidth = $derived.by(() => {
    let max = 0;
    for (const { o, n } of lineNos) max = Math.max(max, o ?? 0, n ?? 0);
    return Math.max(3, String(max).length);
  });
  // Paired -/+ rows (equal adjacent runs) get intraline highlights — see
  // diffIntraline.ts for the pure pairing/split logic.
  const kinds = $derived(shown.map((l) => kind(l)));
  const pairs = $derived(pairChanges(kinds));
  // A pure rename produces no code rows at all — surface it instead of the
  // misleading "No changes" empty state. (Rename meta lines are filtered from
  // `content`, so scan the raw lines.)
  const rename = $derived.by(() => {
    let from: string | null = null;
    let to: string | null = null;
    for (const l of lines) {
      if (l.startsWith("rename from ")) from = l.slice("rename from ".length);
      else if (l.startsWith("rename to ")) to = l.slice("rename to ".length);
      if (from && to) break;
    }
    return from && to ? { from, to } : null;
  });
  // Highlighting is per-line (no cross-line context), the lightweight tradeoff:
  // a line inside a block comment may mis-color, but the DOM stays bounded and
  // there's no whole-file reconstruction. "" when the type is unknown → escaped
  // plain text, same as before.
  const lang = $derived(langFromPath(path));

  /** Classify a diff line for coloring. */
  function kind(line: string): string {
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+++") || line.startsWith("---")) return "meta";
    if (line.startsWith("Binary files ")) return "binary";
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
   *  never gets swept into the highlighter. A -/+ row paired with its partner
   *  gets an intraline mark on the changed segment INSTEAD of syntax colors
   *  (interleaving hljs spans with the mark span would mangle both; the mark is
   *  the more useful signal). Everything routes through an escape (here or
   *  inside highlightCode), so {@html} is XSS-safe under the app CSP. */
  function render(line: string, k: string, i: number): string {
    const text = line || " ";
    if (k === "add" || k === "del") {
      const j = pairs.get(i);
      if (j !== undefined) {
        const a = text.slice(1);
        const b = (shown[j] ?? " ").slice(1);
        const { pre, suf } = splitCommon(a, b);
        if (worthHighlighting(a, b, pre, suf)) {
          const mid = a.slice(pre, a.length - suf);
          return (
            escapeHtml(text.slice(0, 1)) +
            escapeHtml(a.slice(0, pre)) +
            (mid ? `<span class="ln-seg">${escapeHtml(mid)}</span>` : "") +
            escapeHtml(a.slice(a.length - suf))
          );
        }
      }
    }
    if (lang && (k === "add" || k === "del" || k === "ctx")) {
      return escapeHtml(text.slice(0, 1)) + highlightCode(text.slice(1), lang);
    }
    return escapeHtml(text);
  }
</script>

{#if shown.length === 0}
  {#if rename}
    <div class="diff-empty empty-state">Renamed {rename.from} → {rename.to}</div>
  {:else}
    <div class="diff-empty empty-state">No changes in this file.</div>
  {/if}
{:else}
  <div class="diff">
    {#each shown as line, i (i)}
      {@const k = kind(line)}
      {@const code = k === "add" || k === "del" || k === "ctx"}
      {#if k === "binary"}
        <div class="ln meta">Binary file — contents not shown</div>
      {:else if onLineComment && code}
        <div class="ln {k} commentable" class:noted={commentedLines?.has(line)}>
          <button
            class="ln-comment"
            title="Comment on this line (sends to the agent)"
            aria-label="Comment on this line"
            onclick={() => onLineComment({ line, hunk: hunkFor[i] ?? null })}
          >
            <MessageSquarePlus class="size-3" />
          </button><span class="ln-no" style="width: {noWidth}ch">{lineNos[i]?.o ?? ""}</span><span
            class="ln-no"
            style="width: {noWidth}ch">{lineNos[i]?.n ?? ""}</span
          >{@html render(line, k, i)}</div>
      {:else if code}
        <div class="ln {k}"><span class="ln-no" style="width: {noWidth}ch">{lineNos[i]?.o ?? ""}</span><span
            class="ln-no"
            style="width: {noWidth}ch">{lineNos[i]?.n ?? ""}</span
          >{@html render(line, k, i)}</div>
      {:else}
        <div class="ln {k}">{@html render(line, k, i)}</div>
      {/if}
    {/each}
    {#if hidden > 0}
      <div class="ln meta">… {hidden} more line{hidden === 1 ? "" : "s"} hidden</div>
    {/if}
  </div>
{/if}

<style>
  .diff {
    font-family: ui-monospace, monospace;
    font-size: var(--text-sm);
    line-height: 1.5;
    overflow: auto;
    height: 100%;
  }
  .ln {
    display: block;
    white-space: pre;
    padding: 0 8px;
  }
  /* Old/new line-number gutter. Width is set inline (digit-count-scaled);
     user-select: none keeps copied diff text free of the numbers. */
  .ln-no {
    display: inline-block;
    text-align: right;
    margin-right: 1ch;
    color: var(--app-dim);
    opacity: 0.65;
    user-select: none;
  }
  /* Commentable rows reserve a slim gutter; the glyph appears on row hover. */
  .ln.commentable {
    position: relative;
    padding-left: 22px;
  }
  .ln-comment {
    position: absolute;
    left: 2px;
    top: 50%;
    translate: 0 -50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-2xs);
    background: none;
    color: var(--app-dim);
    opacity: 0;
  }
  .ln.commentable:hover .ln-comment {
    opacity: 1;
  }
  /* A queued comment keeps its glyph visible + accented (review-in-progress). */
  .ln.noted .ln-comment {
    opacity: 1;
    color: var(--app-accent);
  }
  .ln-comment:hover {
    color: var(--app-accent);
    background: color-mix(in oklch, var(--app-accent) 14%, transparent);
  }
  /* Add/del rows carry only the background tint; token text color comes from the
     shared `.hljs-*` palette in app.css (which is layered, so an unlayered scoped
     `color` here would override it and flatten every token to one hue). Plain,
     untokenised text falls back to the inherited diff foreground. */
  .add {
    background: color-mix(in oklch, var(--app-diff-add) 18%, transparent);
  }
  .del {
    background: color-mix(in oklch, var(--app-diff-del) 18%, transparent);
  }
  /* Intraline mark: the changed segment of a paired -/+ row, a stronger tint
     over the row's own wash (`:global` — the span arrives via {@html}). */
  .add :global(.ln-seg) {
    background: color-mix(in oklch, var(--app-diff-add) 42%, transparent);
    border-radius: var(--radius-2xs);
  }
  .del :global(.ln-seg) {
    background: color-mix(in oklch, var(--app-diff-del) 42%, transparent);
    border-radius: var(--radius-2xs);
  }
  .hunk {
    color: var(--app-accent);
    background: color-mix(in oklch, var(--app-accent) 8%, transparent);
  }
  .meta {
    color: var(--app-dim);
  }
  /* Text styling is the shared .empty-state (app.css); spacing stays per-site. */
  .diff-empty {
    padding: 16px;
  }
</style>
