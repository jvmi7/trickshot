<script lang="ts" module>
  // Syntax highlighting for fenced code blocks. highlight.js is class-based: it
  // emits `<span class="hljs-…">` wrappers and escapes the source itself, so the
  // colors come entirely from app.css `.hljs-*` rules mapped to the theme's
  // `--base-*` hues (NO highlight.js theme CSS is imported — that would hardcode
  // colors and break theming). Curated language subset keeps the bundle lean.
  import hljs from "highlight.js/lib/core";
  import bash from "highlight.js/lib/languages/bash";
  import css from "highlight.js/lib/languages/css";
  import diff from "highlight.js/lib/languages/diff";
  import dockerfile from "highlight.js/lib/languages/dockerfile";
  import go from "highlight.js/lib/languages/go";
  import javascript from "highlight.js/lib/languages/javascript";
  import json from "highlight.js/lib/languages/json";
  import markdown from "highlight.js/lib/languages/markdown";
  import python from "highlight.js/lib/languages/python";
  import rust from "highlight.js/lib/languages/rust";
  import sql from "highlight.js/lib/languages/sql";
  import typescript from "highlight.js/lib/languages/typescript";
  import xml from "highlight.js/lib/languages/xml";
  import yaml from "highlight.js/lib/languages/yaml";

  for (const [name, lang] of [
    ["bash", bash],
    ["css", css],
    ["diff", diff],
    ["dockerfile", dockerfile],
    ["go", go],
    ["javascript", javascript],
    ["json", json],
    ["markdown", markdown],
    ["python", python],
    ["rust", rust],
    ["sql", sql],
    ["typescript", typescript],
    ["xml", xml],
    ["yaml", yaml],
  ] as const) {
    hljs.registerLanguage(name, lang);
  }

  // Fence tag → registered language (and a few common aliases).
  const LANG_ALIASES: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    console: "bash",
    py: "python",
    rs: "rust",
    yml: "yaml",
    html: "xml",
    svelte: "xml",
    md: "markdown",
    dockerfile: "dockerfile",
  };

  const escapeHtml = (s: string) =>
    s.replace(
      /[&<>]/g,
      (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }) as Record<string, string>)[c] ?? c,
    );

  /** Highlight fenced code → safe HTML. Only highlights a KNOWN language (no
   *  auto-detect, which would mis-color ASCII diagrams in untagged fences); an
   *  untagged/unknown fence renders escaped plain text. */
  export function highlightCode(text: string, lang: string): string {
    const key = LANG_ALIASES[(lang || "").toLowerCase()] ?? (lang || "").toLowerCase();
    if (key && hljs.getLanguage(key)) {
      return hljs.highlight(text, { language: key, ignoreIllegals: true }).value;
    }
    return escapeHtml(text);
  }
</script>

<script lang="ts">
  // Renders untrusted assistant prose (Markdown, optionally with embedded HTML)
  // via @humanspeak/svelte-markdown — it renders to real Svelte components, not
  // {@html}, and is XSS-safe by default (strips `javascript:` URLs and `on*=`
  // handlers), so no manual sanitize step is needed under the app CSP. Element
  // styling + the syntax-highlight palette live in app.css `.markdown`.
  import SvelteMarkdown from "@humanspeak/svelte-markdown";

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
