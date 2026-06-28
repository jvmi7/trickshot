// The ONE home for syntax highlighting. highlight.js is class-based: it emits
// `<span class="hljs-…">` wrappers and escapes the source itself, so the colors
// come entirely from app.css `.hljs-*` rules mapped to the theme's `--base-*`
// hues (NO highlight.js theme CSS is imported — that would hardcode colors and
// break theming). Curated language subset keeps the bundle lean. Consumed by
// both Markdown.svelte (fenced code) and DiffView.svelte (per-line diff code).
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

// Fence tag / file extension → registered language (and a few common aliases).
// Shared by fence tags (```ts) and file extensions (foo.ts), which overlap.
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  rs: "rust",
  yml: "yaml",
  html: "xml",
  htm: "xml",
  svelte: "xml",
  vue: "xml",
  md: "markdown",
  markdown: "markdown",
  dockerfile: "dockerfile",
};

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>]/g,
    (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }) as Record<string, string>)[c] ?? c,
  );

/** Highlight code → safe HTML. Only highlights a KNOWN language (no auto-detect,
 *  which would mis-color ASCII diagrams / plain text); an unknown language
 *  renders as escaped plain text. `lang` is a fence tag, an alias, or a bare
 *  file extension — all resolved through the same alias table. */
export function highlightCode(text: string, lang: string): string {
  const key = LANG_ALIASES[(lang || "").toLowerCase()] ?? (lang || "").toLowerCase();
  if (key && hljs.getLanguage(key)) {
    return hljs.highlight(text, { language: key, ignoreIllegals: true }).value;
  }
  return escapeHtml(text);
}

/** Map a file path to a highlight language key (or "" when unknown). Handles
 *  extensionless special filenames (Dockerfile) and falls back to the last
 *  dotted segment. The returned value is fed straight to `highlightCode`. */
export function langFromPath(path: string | null | undefined): string {
  if (!path) return "";
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : "";
}
