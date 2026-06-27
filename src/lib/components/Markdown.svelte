<script lang="ts">
  // Renders untrusted assistant prose (Markdown, optionally with embedded HTML)
  // via @humanspeak/svelte-markdown — it renders to real Svelte components, not
  // {@html}, and is XSS-safe by default (strips `javascript:` URLs and `on*=`
  // handlers), so no manual sanitize step is needed under the app CSP. Element
  // styling + the syntax-highlight palette live in app.css `.markdown`.
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { highlightCode } from "$lib/highlight";

  // `?? ""` keeps the "missing field renders nothing, never throw" invariant: an
  // assistant message can carry empty/undefined text (see toNeutral).
  let { text }: { text: string } = $props();
</script>

<div class="markdown">
  <SvelteMarkdown source={text ?? ""}>
    {#snippet link({ href, title, children })}
      <!-- External links must open OUT, never navigate the local webview away —
           an in-place navigation white-screens the app under `default-src 'self'`. -->
      <a {href} {title} target="_blank" rel="noreferrer">{@render children?.()}</a>
    {/snippet}

    {#snippet code({ lang, text: codeText })}
      <!-- highlightCode escapes the source itself; the `<span class="hljs-…">`
           output is colored by app.css, not an imported hljs theme. -->
      <pre><code class="hljs">{@html highlightCode(codeText, lang)}</code></pre>
    {/snippet}
  </SvelteMarkdown>
</div>
