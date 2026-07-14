// DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
// (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
// "Deprecated GUI surface" before extending.
// Minimal mode: a global, reversible VIEW FILTER. While on, each user turn is sent
// to the agent with an appended directive asking it to end its reply with a single
// fenced one-sentence summary; the UI then renders ONLY those summaries (plus the
// user's own messages), hiding the full prose and all tool activity. The full
// response still lands in the transcript untouched — toggling minimal off reveals
// everything again (no data is dropped). Both the directive and the parsing live
// here so the marker is defined in exactly ONE place.

/** Sentinel that fences the text-message recap at the end of an agent turn.
 *  Plain ASCII so the model reproduces it verbatim, but unlikely in real prose. */
export const MINIMAL_MARKER = "[[TLDR]]";

/** Most chat bubbles one agent turn may split into (a short burst of texts). */
export const MAX_BUBBLES = 3;

/** Appended (frontend-side) to the user's turn text when minimal mode is on. The
 *  clean user text is what gets echoed into the transcript; only the wire copy
 *  carries this directive, so the user bubble stays clean. */
export const MINIMAL_DIRECTIVE =
  `\n\n---\nMinimal mode is ON. Respond normally above, then add a line containing exactly ` +
  `"${MINIMAL_MARKER}" on its own, and after it reply to me like a casual text message. Be as ` +
  `minimal as possible: STRONGLY prefer ONE short bubble (a single line) — that should cover ` +
  `the large majority of replies. Use a 2nd line only when a distinct point would genuinely be ` +
  `lost by merging it. Use a 3rd line only when it's truly necessary — it should be rare. Never ` +
  `pad, never split a single thought across lines, and when in doubt use fewer. Hard limit ` +
  `${MAX_BUBBLES} lines. Write the way a person actually texts: casual, lowercase is fine, ` +
  `contractions, minimal punctuation. Do NOT use em dashes or en dashes ("—" / "–") at all; ` +
  `use a comma or period, or just start a new line. Don't sound polished or AI-generated. ` +
  `Output nothing after.`;

/** Split an assistant message's text at the marker. `bubbles` is the text-message
 *  recap (one entry per line, capped at MAX_BUBBLES; empty when the marker is
 *  absent — mid-stream, a non-minimal turn, or the model skipped it). `body` is
 *  everything before it (the marker line is stripped so the full prose never shows
 *  the sentinel, in either view mode).
 *
 *  The marker only counts on its OWN line — the directive's contract. An inline
 *  occurrence (quoting this file, discussing the directive, a code fence) must
 *  NOT truncate the rendered message: a bare lastIndexOf would silently hide
 *  everything after a mere mention of the sentinel even with minimal mode off. */
export function splitSummary(text: string): { body: string; bubbles: string[] } {
  const lines = text.split("\n");
  let idx = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k]?.trim() === MINIMAL_MARKER) {
      idx = k;
      break;
    }
  }
  if (idx < 0) return { body: text, bubbles: [] };
  const bubbles = lines
    .slice(idx + 1)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_BUBBLES);
  return { body: lines.slice(0, idx).join("\n").trimEnd(), bubbles };
}